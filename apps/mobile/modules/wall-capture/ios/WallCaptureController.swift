import ARKit
import Foundation
import simd

enum WallCaptureError: Error, LocalizedError {
  case notSupported, noFrame, rectifyFailed, cornersOffPlane

  var errorDescription: String? {
    switch self {
    case .notSupported: return "This device has no LiDAR sensor"
    case .noFrame: return "The camera has not produced a frame yet"
    case .rectifyFailed: return "Could not straighten the photo"
    case .cornersOffPlane: return "No depth behind one of the corners — keep the whole face in view, a little further back, and try again"
    }
  }
}

// Its own ARSession, like object-measure: one camera owner per screen.
final class WallCaptureController: NSObject, ARSessionDelegate {
  static let shared = WallCaptureController()
  let arSession = ARSession()

  private let detectQueue = DispatchQueue(label: "com.fullscale.wallcapture.detect")
  private var detecting = false
  private var lastDetectTime: TimeInterval = 0
  private(set) var liveQuad: DetectedQuad?
  var quadListeners: [(DetectedQuad?) -> Void] = []

  private override init() {
    super.init()
    arSession.delegate = self
  }

  static var isSupported: Bool { ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) }

  func start() {
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravityAndHeading
    config.planeDetection = [.horizontal, .vertical]
    if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) { config.sceneReconstruction = .mesh }
    // The depth map is the corner fallback when no plane covers a corner (see WallRectifier.unproject).
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { config.frameSemantics.insert(.sceneDepth) }
    arSession.run(config, options: [.resetTracking, .removeExistingAnchors])
  }

  func stop() { arSession.pause() }

  // ~8 Hz live detection for the on-screen outline. The capture itself
  // detects again on the exact frame it rectifies.
  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard frame.timestamp - lastDetectTime > 0.12, !detecting else { return }
    lastDetectTime = frame.timestamp
    detecting = true
    let buffer = frame.capturedImage
    detectQueue.async { [weak self] in
      let quad = WallRectifier.detect(in: buffer)
      DispatchQueue.main.async {
        guard let self else { return }
        self.liveQuad = quad
        self.quadListeners.forEach { $0(quad) }
        self.detecting = false
      }
    }
  }

  func capture(vertical: Bool) throws -> RectifiedFace {
    guard let frame = arSession.currentFrame else { throw WallCaptureError.noFrame }
    let detected = WallRectifier.detect(in: frame.capturedImage)
    let quad = detected ?? WallRectifier.fullRawFrame()
    guard let url = WallRectifier.rectify(frame.capturedImage, quad: quad) else { throw WallCaptureError.rectifyFailed }
    guard let corners = WallRectifier.measure(frame: frame, session: arSession, quad: quad, vertical: vertical) else {
      throw WallCaptureError.cornersOffPlane
    }
    let pose = WallRectifier.pose(corners, vertical: vertical)
    return RectifiedFace(
      imagePath: url.path, cornersWorld: corners,
      widthMeters: pose.width, heightMeters: pose.height, center: pose.center, yawDeg: pose.yawDeg,
      detected: detected != nil, confidence: quad.confidence
    )
  }
}
