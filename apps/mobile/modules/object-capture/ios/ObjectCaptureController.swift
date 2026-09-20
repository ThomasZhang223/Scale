import Foundation
import RealityKit
import SwiftUI
import simd

enum ObjectCaptureError: Error, LocalizedError {
  case notSupported
  case notStarted
  case detectionRefused
  case captureFailed(String)
  case reconstructionFailed(String)
  case cancelled

  var errorDescription: String? {
    switch self {
    case .notSupported:
      return "Object Capture needs an iPhone 12 Pro or later with LiDAR on iOS 17 or later"
    case .notStarted: return "No capture session is running"
    case .detectionRefused:
      return "Could not lock onto the object — move so it fills the frame, then try again"
    case .captureFailed(let why): return "Capture failed: \(why)"
    case .reconstructionFailed(let why): return "Could not build the model: \(why)"
    case .cancelled: return "Capture was cancelled"
    }
  }
}

struct ReconstructionResult {
  let usdzPath: String
  let glbPath: String
  let bboxMeters: SIMD3<Float>
  let imageCount: Int
}

// One ObjectCaptureSession at a time, owned here so the SwiftUI view, the
// Expo module and the photogrammetry step all see the same one. Everything
// on ObjectCaptureSession is main-actor isolated, so this whole class is.
//
// Separate from modules/object-measure on purpose: that module is a one-tap
// LiDAR bounding-box measurement; this one is the guided orbit that yields a
// real textured mesh. They never share a camera session (iOS gives the
// camera to one at a time) and never run on the same screen.
@MainActor
final class ObjectCaptureController {
  static let shared = ObjectCaptureController()

  private(set) var session: ObjectCaptureSession?
  private var rootDir: URL?
  private var imagesDir: URL?
  private var checkpointDir: URL?

  private var stateTask: Task<Void, Never>?
  private var feedbackTask: Task<Void, Never>?
  private var shotsTask: Task<Void, Never>?
  private var finishContinuation: CheckedContinuation<Void, Error>?
  private var photogrammetry: PhotogrammetrySession?

  // Multicast to the module (→ JS events) and the native view (→ attach the
  // SwiftUI ObjectCaptureView once a session exists).
  var stateListeners: [(String) -> Void] = []
  var feedbackListeners: [([String]) -> Void] = []
  var shotsListeners: [(Int, Int) -> Void] = []
  var progressListeners: [(Double, String) -> Void] = []
  var sessionListeners: [(ObjectCaptureSession?) -> Void] = []

  private init() {}

  static var isSupported: Bool {
    ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported
  }

  // MARK: - Session lifecycle

  func start() throws {
    guard Self.isSupported else { throw ObjectCaptureError.notSupported }
    teardown(deleteFiles: true)

    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ObjectCapture-\(UUID().uuidString)", isDirectory: true)
    let images = root.appendingPathComponent("Images", isDirectory: true)
    let checkpoints = root.appendingPathComponent("Checkpoints", isDirectory: true)
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: checkpoints, withIntermediateDirectories: true)
    rootDir = root
    imagesDir = images
    checkpointDir = checkpoints

    let s = ObjectCaptureSession()
    var config = ObjectCaptureSession.Configuration()
    // The checkpoint directory is what lets PhotogrammetrySession skip its
    // own feature extraction later: the capture already did it.
    config.checkpointDirectory = checkpoints
    // Keeps taking images beyond the guided dial; more views, better mesh.
    config.isOverCaptureEnabled = true
    s.start(imagesDirectory: images, configuration: config)
    session = s
    sessionListeners.forEach { $0(s) }
    observe(s)
  }

  func startDetecting() throws {
    guard let session else { throw ObjectCaptureError.notStarted }
    guard session.startDetecting() else { throw ObjectCaptureError.detectionRefused }
  }

  func startCapturing() throws {
    guard let session else { throw ObjectCaptureError.notStarted }
    session.startCapturing()
  }

  // Resolves once the session reports .completed (all images written), which
  // is the moment reconstruction may begin. Throws on .failed.
  func finish() async throws {
    guard let session else { throw ObjectCaptureError.notStarted }
    if case .completed = session.state { return }
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      finishContinuation = c
      session.finish()
    }
  }

  func cancel() {
    photogrammetry?.cancel()
    teardown(deleteFiles: true)
  }

  private func teardown(deleteFiles: Bool) {
    stateTask?.cancel(); feedbackTask?.cancel(); shotsTask?.cancel()
    stateTask = nil; feedbackTask = nil; shotsTask = nil
    finishContinuation?.resume(throwing: ObjectCaptureError.cancelled)
    finishContinuation = nil
    if let session, session.state != .completed { session.cancel() }
    session = nil
    sessionListeners.forEach { $0(nil) }
    photogrammetry = nil
    if deleteFiles, let rootDir { try? FileManager.default.removeItem(at: rootDir) }
    rootDir = nil; imagesDir = nil; checkpointDir = nil
  }

  private func observe(_ s: ObjectCaptureSession) {
    stateTask = Task { [weak self] in
      for await state in s.stateUpdates {
        guard let self, !Task.isCancelled else { return }
        self.stateListeners.forEach { $0(Self.describe(state)) }
        switch state {
        case .completed:
          self.finishContinuation?.resume(); self.finishContinuation = nil
        case .failed(let error):
          self.finishContinuation?.resume(throwing: ObjectCaptureError.captureFailed(error.localizedDescription))
          self.finishContinuation = nil
        default: break
        }
      }
    }
    feedbackTask = Task { [weak self] in
      for await feedback in s.feedbackUpdates {
        guard let self, !Task.isCancelled else { return }
        // Case names straight from the enum ("objectTooClose", "movingTooFast", …).
        // No exhaustive switch: a new case in a future SDK must not be a crash.
        self.feedbackListeners.forEach { $0(feedback.map { "\($0)" }.sorted()) }
      }
    }
    shotsTask = Task { [weak self] in
      var last = -1
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 400_000_000)
        guard let self, let session = self.session else { return }
        let n = session.numberOfShotsTaken
        if n != last {
          last = n
          self.shotsListeners.forEach { $0(n, session.maximumNumberOfInputImages) }
        }
      }
    }
  }

  private static func describe(_ state: ObjectCaptureSession.CaptureState) -> String {
    switch state {
    case .initializing: return "initializing"
    case .ready: return "ready"
    case .detecting: return "detecting"
    case .capturing: return "capturing"
    case .finishing: return "finishing"
    case .completed: return "completed"
    case .failed: return "failed"
    @unknown default: return "unknown"
    }
  }

  // MARK: - Reconstruction

  // On-device photogrammetry over the captured folder. `detail` is one of
  // preview / reduced / medium — the levels iOS supports; full and raw are
  // macOS only. reduced is the demo default: a couple of minutes on an
  // iPhone 15 Pro for ~60 images, with textures.
  func reconstruct(detail: String) async throws -> ReconstructionResult {
    guard let imagesDir, let rootDir else { throw ObjectCaptureError.notStarted }
    guard PhotogrammetrySession.isSupported else { throw ObjectCaptureError.notSupported }

    // iOS 27 SDK: PhotogrammetrySession.Request.Detail exposes only .reduced
    // on iOS (preview/medium/full/raw are macOS) — found by compiling, not
    // by reading docs. The JS type still names the three so a future SDK
    // can widen this switch without touching the screen.
    guard detail == "reduced" else {
      throw ObjectCaptureError.reconstructionFailed("detail \(detail) is not available on iOS; use reduced")
    }
    let level: PhotogrammetrySession.Request.Detail = .reduced

    var config = PhotogrammetrySession.Configuration()
    config.checkpointDirectory = checkpointDir
    config.featureSensitivity = .normal
    config.sampleOrdering = .sequential

    let ps = try PhotogrammetrySession(input: imagesDir, configuration: config)
    photogrammetry = ps
    let usdzURL = rootDir.appendingPathComponent("model.usdz")
    try? FileManager.default.removeItem(at: usdzURL)
    try ps.process(requests: [.modelFile(url: usdzURL, detail: level)])

    var modelURL: URL?
    do {
      for try await output in ps.outputs {
        switch output {
        case .requestProgress(_, let fraction):
          progressListeners.forEach { $0(fraction, "reconstructing") }
        case .requestComplete(_, let result):
          if case .modelFile(let url) = result { modelURL = url }
        case .requestError(_, let error):
          throw ObjectCaptureError.reconstructionFailed(error.localizedDescription)
        case .processingCancelled:
          throw ObjectCaptureError.cancelled
        default:
          break
        }
      }
    } catch let error as ObjectCaptureError {
      throw error
    } catch {
      throw ObjectCaptureError.reconstructionFailed(error.localizedDescription)
    }
    photogrammetry = nil

    guard let modelURL else {
      throw ObjectCaptureError.reconstructionFailed("PhotogrammetrySession finished without a model file")
    }

    progressListeners.forEach { $0(1.0, "exporting") }
    let glbURL = rootDir.appendingPathComponent("model.glb")
    let bbox = try GLBExporter.export(usdz: modelURL, to: glbURL)

    let imageCount = (try? FileManager.default.contentsOfDirectory(atPath: imagesDir.path).count) ?? 0
    return ReconstructionResult(
      usdzPath: modelURL.path,
      glbPath: glbURL.path,
      bboxMeters: bbox,
      imageCount: imageCount
    )
  }
}
