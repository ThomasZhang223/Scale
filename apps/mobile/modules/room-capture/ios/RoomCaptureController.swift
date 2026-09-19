import ARKit
import CoreLocation
import RoomPlan
import simd

enum RoomCaptureError: Error, LocalizedError {
  case notSupported
  case alreadyRunning
  case notRunning

  var errorDescription: String? {
    switch self {
    case .notSupported: return "RoomPlan is not supported on this device"
    case .alreadyRunning: return "A room capture session is already running"
    case .notRunning: return "No room capture session is running"
    }
  }
}

// Owns the ARSession + RoomCaptureSession pair for one sweep, and the frame
// ring buffer. One controller instance per module; a new sweep resets state
// in `start()` rather than allocating a new controller.
//
// Deliberately built on RoomCaptureSession, never RoomCaptureView — see the
// module README and plan section 2. On iOS 26 built with Xcode 26,
// RoomCaptureView fails to start with a RealityKit tonemapLUT assertion
// inside Apple's own renderer. There is no workaround.
final class RoomCaptureController: NSObject {
  struct Progress {
    let wallCount: Int
    let openingCount: Int
    let objectCount: Int
  }

  // One controller for the app's one active scan. The native view (which has
  // no reachable reference to the Module instance) reads `arSession` off this
  // singleton to render the live camera feed — see RoomCaptureNativeView.
  static let shared = RoomCaptureController()

  let arSession = ARSession()
  private var roomCaptureSession: RoomCaptureSession?
  private var stopContinuation: CheckedContinuation<CapturedRoom, Error>?

  private let locationManager = CLLocationManager()
  // ceiling: 0 until the first valid CLHeading arrives. northBearingDeg is a
  // human cross-check value only (contracts.md: "the one value a reviewer
  // can check against a compass on the table") — no consumer computes with
  // it, so defaulting it carries no decision weight. The ARKit frame's own
  // true-north alignment comes from worldAlignment = .gravityAndHeading
  // below, set independently of this reading.
  private var northBearingDeg: Double = 0

  private(set) var frameRingBuffer: [RoomFrameSample] = []
  private let frameRingBufferCapacity = 60
  private var lastFrameSampleTime: TimeInterval = 0
  // ~60 samples over a sweep that plan section 1 estimates near a minute.
  private let frameSampleInterval: TimeInterval = 1.0

  // Multicast, not a single closure: the module's OnCreate hook adds a
  // listener that forwards to JS via sendEvent, and the native view (for its
  // own on-screen overlay) adds a second, independent one. Neither should
  // have to know the other exists.
  private var instructionListeners: [(String) -> Void] = []
  private var progressListeners: [(Progress) -> Void] = []

  private override init() {
    super.init()
    arSession.delegate = self
    locationManager.delegate = self
  }

  func addInstructionListener(_ listener: @escaping (String) -> Void) {
    instructionListeners.append(listener)
  }

  func addProgressListener(_ listener: @escaping (Progress) -> Void) {
    progressListeners.append(listener)
  }

  var isSupported: Bool {
    RoomCaptureSession.isSupported
  }

  func start() throws {
    guard isSupported else { throw RoomCaptureError.notSupported }
    guard roomCaptureSession == nil else { throw RoomCaptureError.alreadyRunning }

    frameRingBuffer.removeAll()
    lastFrameSampleTime = 0

    // Run our own configuration on `arSession` BEFORE RoomCaptureSession ever
    // touches it, with worldAlignment = .gravityAndHeading. "Inject your own
    // ARSession" is a documented RoomPlan capability specifically so settings
    // like this carry over into the session RoomCaptureSession then re-runs
    // internally — see plan section 2. We do not attempt to also keep scene
    // depth alive through that re-run; the object scan owns depth on its own
    // separate session instead (plan: "neither wants both at once").
    let arConfig = ARWorldTrackingConfiguration()
    arConfig.worldAlignment = .gravityAndHeading
    arConfig.planeDetection = [.horizontal, .vertical]
    arSession.run(arConfig)

    locationManager.requestWhenInUseAuthorization()
    if CLLocationManager.headingAvailable() {
      locationManager.startUpdatingHeading()
    }

    let session = RoomCaptureSession(arSession: arSession)
    session.delegate = self
    session.run(configuration: RoomCaptureSession.Configuration())
    roomCaptureSession = session
  }

  func stopAndSerialize() async throws -> [String: Any] {
    guard let session = roomCaptureSession else { throw RoomCaptureError.notRunning }

    let capturedRoom = try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<CapturedRoom, Error>) in
      self.stopContinuation = continuation
      session.stop()
    }

    roomCaptureSession = nil
    locationManager.stopUpdatingHeading()
    arSession.pause()

    return RoomCaptureSerializer.serialize(capturedRoom, northBearingDeg: northBearingDeg)
  }

  private func reportProgress(_ room: CapturedRoom) {
    let progress = Progress(
      wallCount: room.walls.count,
      openingCount: room.doors.count + room.windows.count + room.openings.count,
      objectCount: room.objects.count
    )
    progressListeners.forEach { $0(progress) }
  }
}

extension RoomCaptureController: RoomCaptureSessionDelegate {
  func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
    let name = RoomCaptureSerializer.instructionName(instruction)
    instructionListeners.forEach { $0(name) }
  }

  func captureSession(_ session: RoomCaptureSession, didAdd room: CapturedRoom) {
    reportProgress(room)
  }

  func captureSession(_ session: RoomCaptureSession, didChange room: CapturedRoom) {
    reportProgress(room)
  }

  func captureSession(_ session: RoomCaptureSession, didRemove room: CapturedRoom) {
    reportProgress(room)
  }

  func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
    if let error {
      stopContinuation?.resume(throwing: error)
      stopContinuation = nil
      return
    }
    Task {
      do {
        // ceiling: beautifyObjects deliberately OFF. Apple's own description
        // says it unifies per-object attributes across a group (e.g. every
        // chair at a table gets the same attributes) — plan risk item warns
        // this could destroy the per-object signal before anyone reads it.
        // Diff a rebuild with and without it (plan section 12) before
        // turning this on.
        let builder = RoomBuilder(options: [])
        let room = try await builder.capturedRoom(from: data)
        self.stopContinuation?.resume(returning: room)
      } catch {
        self.stopContinuation?.resume(throwing: error)
      }
      self.stopContinuation = nil
    }
  }
}

extension RoomCaptureController: ARSessionDelegate {
  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    // Gate on tracking, not on brightness (plan section 1): a garbage pose
    // makes a garbage frame sample regardless of how well-lit it looks.
    guard frame.camera.trackingState == .normal else { return }
    guard frame.timestamp - lastFrameSampleTime >= frameSampleInterval else { return }
    lastFrameSampleTime = frame.timestamp

    let sample = RoomFrameSampler.sample(from: frame)
    if frameRingBuffer.count < frameRingBufferCapacity {
      frameRingBuffer.append(sample)
    } else {
      // ceiling: once full, replace a uniformly random existing sample
      // instead of dropping the newest. A sweep runs 60-120s, so holding the
      // first 60 samples (the old behavior) starves every wall reached late
      // in the sweep; a true sliding window starves the ones reached early.
      // Random replacement approximates pose spread across the whole sweep
      // for one line, with no scoring. What the wall-texture step (plan
      // section 4b step 3) actually wants is pose DIVERSITY, not this
      // approximation — a real implementation would evict the sample with
      // the smallest angular distance to its nearest neighbour instead.
      frameRingBuffer[Int.random(in: 0..<frameRingBufferCapacity)] = sample
    }
  }
}

extension RoomCaptureController: CLLocationManagerDelegate {
  func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
    // CLHeading: "Values less than 0 are invalid."
    guard newHeading.trueHeading >= 0 else { return }
    northBearingDeg = newHeading.trueHeading
  }
}
