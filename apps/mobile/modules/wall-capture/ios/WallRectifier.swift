import ARKit
import CoreImage
import UIKit
import Vision
import simd

// Standard CV, no learning: Vision's rectangle detector finds the largest
// quadrilateral in the frame (the wall, floor or ceiling the user framed),
// Core Image's perspective correction is the four-point transform that
// turns it into the straight-on "bird's-eye" view, and ARKit raycasts on the
// same four corners give the face its size and pose in metres.
//
// Coordinate spaces, stated once because they all differ:
//   Vision:   normalised, origin bottom-left, in the raw (landscape) buffer
//   CoreImage: pixels, origin bottom-left, same raw buffer  -> Vision × extent
//   ARKit raycast: normalised, origin top-left, same raw buffer -> y' = 1 - y
struct DetectedQuad {
  // Raw-buffer normalised, bottom-left origin (Vision order).
  let topLeft: CGPoint, topRight: CGPoint, bottomRight: CGPoint, bottomLeft: CGPoint
  let confidence: Float
  var corners: [CGPoint] { [topLeft, topRight, bottomRight, bottomLeft] }
}

struct RectifiedFace {
  let imagePath: String
  let cornersWorld: [SIMD3<Float>] // 4, same order as the quad, nil-free
  let widthMeters: Float
  let heightMeters: Float
  let center: SIMD3<Float>
  let yawDeg: Float
  let detected: Bool // false = no rectangle found, the full frame was used
  let confidence: Float
}

enum WallRectifier {
  private static let ciContext = CIContext()

  static func detect(in buffer: CVPixelBuffer) -> DetectedQuad? {
    let request = VNDetectRectanglesRequest()
    request.minimumAspectRatio = 0.2
    request.maximumAspectRatio = 1.0
    request.minimumSize = 0.25       // a wall fills the frame; ignore posters and outlets
    request.quadratureTolerance = 30 // walls shot from an angle are far from square
    request.minimumConfidence = 0.5
    request.maximumObservations = 1
    let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let r = request.results?.first else { return nil }
    return DetectedQuad(topLeft: r.topLeft, topRight: r.topRight, bottomRight: r.bottomRight, bottomLeft: r.bottomLeft, confidence: r.confidence)
  }

  /// The whole frame as a quad, for when nothing was detected but the user still framed the face.
  static func fullFrame() -> DetectedQuad {
    DetectedQuad(topLeft: CGPoint(x: 0.02, y: 0.98), topRight: CGPoint(x: 0.98, y: 0.98),
                 bottomRight: CGPoint(x: 0.98, y: 0.02), bottomLeft: CGPoint(x: 0.02, y: 0.02), confidence: 0)
  }

  /// Four-point transform: the quad's content, straight on, rotated upright for a portrait phone.
  static func rectify(_ buffer: CVPixelBuffer, quad: DetectedQuad) -> URL? {
    let image = CIImage(cvPixelBuffer: buffer)
    let w = image.extent.width, h = image.extent.height
    let px = { (p: CGPoint) in CIVector(x: p.x * w, y: p.y * h) }
    guard let filter = CIFilter(name: "CIPerspectiveCorrection") else { return nil }
    filter.setValue(image, forKey: kCIInputImageKey)
    filter.setValue(px(quad.topLeft), forKey: "inputTopLeft")
    filter.setValue(px(quad.topRight), forKey: "inputTopRight")
    filter.setValue(px(quad.bottomRight), forKey: "inputBottomRight")
    filter.setValue(px(quad.bottomLeft), forKey: "inputBottomLeft")
    guard let corrected = filter.outputImage else { return nil }
    // The raw buffer is landscape-right relative to a portrait phone.
    let upright = corrected.oriented(.right)
    guard let cg = ciContext.createCGImage(upright, from: upright.extent) else { return nil }
    let ui = UIImage(cgImage: cg)
    // ~1600 px long edge: enough for a wall texture, small enough to keep.
    let longEdge = max(ui.size.width, ui.size.height)
    let scale = min(1, 1600 / max(longEdge, 1))
    let size = CGSize(width: ui.size.width * scale, height: ui.size.height * scale)
    let fmt = UIGraphicsImageRendererFormat.default(); fmt.scale = 1
    let small = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in ui.draw(in: CGRect(origin: .zero, size: size)) }
    guard let data = small.jpegData(compressionQuality: 0.88) else { return nil }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("face-\(UUID().uuidString).jpg")
    do { try data.write(to: url) } catch { return nil }
    return url
  }

  /// World points for the four corners, by raycast against the face's plane. Walls are vertical
  /// planes, floor and ceiling horizontal; an estimated plane is accepted when no detected plane
  /// geometry covers the corner yet. Nil if any corner misses — never a guessed corner.
  static func measure(frame: ARFrame, session: ARSession, quad: DetectedQuad, vertical: Bool) -> [SIMD3<Float>]? {
    var points: [SIMD3<Float>] = []
    for c in quad.corners {
      let imagePoint = CGPoint(x: c.x, y: 1 - c.y) // Vision bottom-left -> ARKit top-left
      let alignment: ARRaycastQuery.TargetAlignment = vertical ? .vertical : .horizontal
      var hit: ARRaycastResult?
      for target in [ARRaycastQuery.Target.existingPlaneGeometry, .estimatedPlane] {
        let query = frame.raycastQuery(from: imagePoint, allowing: target, alignment: alignment)
        if let h = session.raycast(query).first { hit = h; break }
      }
      guard let hit else { return nil }
      let t = hit.worldTransform.columns.3
      points.append(SIMD3(t.x, t.y, t.z))
    }
    return points
  }

  /// Size and pose from four world corners (top-left, top-right, bottom-right, bottom-left).
  static func pose(_ p: [SIMD3<Float>], vertical: Bool) -> (width: Float, height: Float, center: SIMD3<Float>, yawDeg: Float) {
    let center = (p[0] + p[1] + p[2] + p[3]) / 4
    let top = simd_length(p[1] - p[0]), bottom = simd_length(p[2] - p[3])
    let left = simd_length(p[3] - p[0]), right = simd_length(p[2] - p[1])
    let width = (top + bottom) / 2
    let height = (left + right) / 2
    // Yaw from the bottom edge direction on the floor plane, CCW seen from +Y (contracts.md).
    let d = p[2] - p[3]
    let yaw = atan2(-d.z, d.x) * 180 / .pi
    return (width, height, center, vertical ? yaw : 0)
  }
}
