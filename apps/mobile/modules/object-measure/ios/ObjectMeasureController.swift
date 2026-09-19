import ARKit
import AVFoundation
import CoreGraphics

enum ObjectMeasureError: Error, LocalizedError {
  case notSupported
  case raycastFailed
  case insufficientSamples
  case alreadyMeasuring

  var errorDescription: String? {
    switch self {
    case .notSupported: return "LiDAR scene depth is not supported on this device"
    case .raycastFailed: return "Could not find a support plane under the tap"
    case .insufficientSamples: return "Not enough LiDAR samples survived filtering — move closer, add light, or try a matte object"
    case .alreadyMeasuring: return "A measurement is already in progress"
    }
  }
}

struct ObjectMeasureResult {
  let widthMeters: Float
  let heightMeters: Float
  let depthMeters: Float
  let yawDeg: Float
  // The surviving fraction, of the frame closest to the reported median —
  // contracts.md's `measure.confidence`.
  let confidence: Float
  // Local file paths (already written to disk), sharpest first.
  let framePaths: [String]
  let ambientIntensityLux: Float?
  let ambientColorTemperatureK: Float?
  // For the point-cloud ghost. One frame's worth — see the note in
  // medianMeasurement below.
  let ghostPoints: [SIMD3<Float>]
}

// One ARSession, one object at a time. Owns the raycast-and-grow measurement
// (ObjectMeasurer), the RGB sweep for the generator, and the exposure lock —
// see plan section 1. This session's config never requests plane detection
// beyond horizontal and never asks for anything the room scan needs; the two
// modules never share an ARSession (iOS gives the camera to one session at a
// time; see modules/object-measure/README.md).
final class ObjectMeasureController: NSObject {
  static let shared = ObjectMeasureController()

  let arSession = ARSession()

  private let queue = DispatchQueue(label: "com.fullscale.objectmeasure")
  private var seed: ObjectSeed?
  private var collectedMeasurements: [ObjectMeasurement] = []
  private var measurementContinuation: CheckedContinuation<[ObjectMeasurement], Error>?
  private var framesAttempted = 0
  private let framesToMedianOver = 8
  private let maxFramesToAttempt = 90 // ~3s at 30fps before giving up

  private var isCollectingRGBFrames = false
  private var rgbCandidates: [(image: CGImage, sharpness: Double)] = []
  private var rgbContinuation: CheckedContinuation<Void, Never>?
  private var pendingMeasurementForCrop: ObjectMeasurement?
  private let rgbCandidateTarget = 16
  private let rgbUploadCount = 8

  private override init() {
    super.init()
    arSession.delegate = self
  }

  func start() {
    let config = ARWorldTrackingConfiguration()
    config.planeDetection = [.horizontal]
    // The object scan owns sceneDepth. The room scan deliberately does not
    // request it — see modules/room-capture's README.
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
      config.frameSemantics.insert(.sceneDepth)
    }
    config.isLightEstimationEnabled = true
    arSession.run(config)
  }

  func stop() {
    arSession.pause()
  }

  func measure(normalizedTapPoint: CGPoint) async throws -> ObjectMeasureResult {
    guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
      throw ObjectMeasureError.notSupported
    }
    guard let currentFrame = arSession.currentFrame else { throw ObjectMeasureError.raycastFailed }
    guard let seed = ObjectMeasurer.raycastSeed(
      session: arSession,
      frame: currentFrame,
      normalizedTapPoint: normalizedTapPoint
    ) else {
      throw ObjectMeasureError.raycastFailed
    }

    // Setup and continuation registration happen in the SAME queue.async
    // block deliberately: doing them as two separate hops left a window
    // where a delegate callback could fire against a seed with no
    // continuation registered yet to resolve.
    let collected = try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<[ObjectMeasurement], Error>) in
      queue.async {
        guard self.measurementContinuation == nil else {
          continuation.resume(throwing: ObjectMeasureError.alreadyMeasuring)
          return
        }
        self.seed = seed
        self.collectedMeasurements = []
        self.framesAttempted = 0
        self.measurementContinuation = continuation
      }
    }

    guard let median = Self.medianMeasurement(of: collected) else {
      throw ObjectMeasureError.insufficientSamples
    }

    // plan section 1, item 3: let auto-exposure settle on the framed object
    // (~300 ms), then lock exposure and white balance so every frame in the
    // RGB sweep agrees with the others. Never touch focus — visual-inertial
    // tracking depends on it.
    lockExposureAndWhiteBalance()
    try? await Task.sleep(nanoseconds: 300_000_000)

    let framePaths = try await collectAndWriteFrames(measurement: median)
    let light = arSession.currentFrame?.lightEstimate

    return ObjectMeasureResult(
      widthMeters: median.widthMeters,
      heightMeters: median.heightMeters,
      depthMeters: median.depthMeters,
      yawDeg: median.yawDeg,
      confidence: Float(median.survivingSampleCount) / Float(max(median.totalSampleCount, 1)),
      framePaths: framePaths,
      ambientIntensityLux: light.map { Float($0.ambientIntensity) },
      ambientColorTemperatureK: light.map { Float($0.ambientColorTemperature) },
      ghostPoints: median.points.map { SIMD3($0.x, $0.y, $0.z) }
    )
  }

  // ceiling: locks exposure/white balance only. Apple's guidance for
  // configurableCaptureDeviceForPrimaryCamera warns against extreme changes
  // to this device — this qualifies as mild — but explicitly never touch
  // focus, which visual-inertial tracking depends on.
  private func lockExposureAndWhiteBalance() {
    guard let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera else {
      return
    }
    do {
      try device.lockForConfiguration()
      if device.isExposureModeSupported(.locked) {
        device.exposureMode = .locked
      }
      if device.isWhiteBalanceModeSupported(.locked) {
        device.whiteBalanceMode = .locked
      }
      device.unlockForConfiguration()
    } catch {
      // Non-fatal: the sweep still proceeds with auto exposure/WB, just
      // less consistent frame to frame.
    }
  }

  // Component-wise median (plan section 1, step 5). Yaw is a plain numeric
  // median, not a circular one — ceiling: this can misbehave for an object
  // whose true yaw sits right at the 0/90 boundary, where noise can flip
  // which edge the fitter calls "width" between frames. Untested on a real
  // device; revisit if the demo ever measures a near-45-degree object badly.
  private static func medianMeasurement(of measurements: [ObjectMeasurement]) -> ObjectMeasurement? {
    guard !measurements.isEmpty else { return nil }
    func median(_ values: [Float]) -> Float {
      let sorted = values.sorted()
      let mid = sorted.count / 2
      return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }

    let width = median(measurements.map(\.widthMeters))
    let height = median(measurements.map(\.heightMeters))
    let depth = median(measurements.map(\.depthMeters))
    let yaw = median(measurements.map(\.yawDeg))
    let survivingRatio = measurements.map { Float($0.survivingSampleCount) / Float(max($0.totalSampleCount, 1)) }
    let confidenceRatio = median(survivingRatio)
    let totalSample = 10000 // synthetic denominator so confidenceRatio round-trips exactly
    let bestFrame = measurements.max(by: { $0.points.count < $1.points.count }) ?? measurements[0]

    return ObjectMeasurement(
      widthMeters: width,
      heightMeters: height,
      depthMeters: depth,
      yawDeg: yaw,
      centerWorld: bestFrame.centerWorld,
      survivingSampleCount: Int(confidenceRatio * Float(totalSample)),
      totalSampleCount: totalSample,
      points: bestFrame.points // ceiling: the ghost renders one frame's raw
      // points, not a fused cloud across the median. Cosmetic only — it
      // never feeds bboxMeters — and cheap to upgrade to a merge later.
    )
  }
}

extension ObjectMeasureController: ARSessionDelegate {
  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    queue.async { [weak self] in
      guard let self else { return }

      if let seed = self.seed, self.measurementContinuation != nil {
        self.framesAttempted += 1
        if let m = ObjectMeasurer.measure(frame: frame, seed: seed) {
          self.collectedMeasurements.append(m)
        }
        if self.collectedMeasurements.count >= self.framesToMedianOver {
          let results = self.collectedMeasurements
          self.finishMeasurementCollection(.success(results))
        } else if self.framesAttempted >= self.maxFramesToAttempt {
          self.finishMeasurementCollection(.failure(ObjectMeasureError.insufficientSamples))
        }
      }

      if self.isCollectingRGBFrames, let measurement = self.pendingMeasurementForCrop {
        self.handleCandidateFrame(frame, measurement: measurement)
      }
    }
  }

  // Always called on `queue`.
  private func finishMeasurementCollection(_ result: Result<[ObjectMeasurement], Error>) {
    let continuation = measurementContinuation
    measurementContinuation = nil
    seed = nil
    switch result {
    case .success(let measurements): continuation?.resume(returning: measurements)
    case .failure(let error): continuation?.resume(throwing: error)
    }
  }

  private func collectAndWriteFrames(measurement: ObjectMeasurement) async throws -> [String] {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      queue.async {
        self.rgbCandidates = []
        self.pendingMeasurementForCrop = measurement
        self.isCollectingRGBFrames = true
        self.rgbContinuation = continuation
      }
    }

    let best = queue.sync {
      rgbCandidates
        .sorted { $0.sharpness > $1.sharpness }
        .prefix(rgbUploadCount)
    }
    return best.compactMap { candidate in
      ObjectFrameProcessor.writeJPEG(candidate.image)?.path
    }
  }

  // Always called on `queue`.
  private func handleCandidateFrame(_ frame: ARFrame, measurement: ObjectMeasurement) {
    guard let cropped = ObjectFrameProcessor.croppedImage(frame: frame, measurement: measurement) else {
      return
    }
    let sharpness = ObjectFrameProcessor.sharpnessScore(cropped)
    rgbCandidates.append((image: cropped, sharpness: sharpness))

    if rgbCandidates.count >= rgbCandidateTarget {
      isCollectingRGBFrames = false
      pendingMeasurementForCrop = nil
      let continuation = rgbContinuation
      rgbContinuation = nil
      continuation?.resume()
    }
  }
}
