import ARKit
import CoreImage
import ImageIO
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

  // The raw ARKit buffer is EXIF .right relative to the portrait UI: raw left = physical top,
  // raw top = physical right. Vision labels corners in the frame it is given, so its raw-frame
  // labels are a quarter turn off the wall's physical corners. Relabel once here; the
  // coordinates themselves stay raw-buffer normalised (bottom-left origin). Without this,
  // width and height swap, yaw is tracking noise, and the floor polygon collapses.
  private static func uprightLabels(_ q: DetectedQuad) -> DetectedQuad {
    DetectedQuad(topLeft: q.bottomLeft, topRight: q.topLeft, bottomRight: q.topRight, bottomLeft: q.bottomRight, confidence: q.confidence)
  }

  static func detect(in buffer: CVPixelBuffer) -> DetectedQuad? {
    detect(handler: VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])).map(uprightLabels)
  }

  /// The whole raw ARKit buffer as a quad with physical labels: the live-capture fallback.
  static func fullRawFrame() -> DetectedQuad { uprightLabels(fullFrame()) }

  // A wall the user framed covers most of the photo. Vision ranks by edge confidence, not
  // size, so a window or picture frame can be the one observation returned; below this
  // coverage it is not the face. ceiling: tuned by eye — a portrait shot of a 4 × 2.6 m wall
  // filling the width covers ~0.49; windows, doors and frames ≤ ~0.25.
  private static let minimumCoverage: CGFloat = 0.35

  private static func coverage(_ r: VNRectangleObservation) -> CGFloat {
    let p = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft]
    var a: CGFloat = 0
    for i in 0..<4 { let q = p[i], n = p[(i + 1) % 4]; a += q.x * n.y - n.x * q.y }
    return abs(a) / 2
  }

  static func detect(in cgImage: CGImage) -> DetectedQuad? {
    detect(handler: VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:]))
  }

  private static func detect(handler: VNImageRequestHandler) -> DetectedQuad? {
    let request = VNDetectRectanglesRequest()
    request.minimumAspectRatio = 0.2
    request.maximumAspectRatio = 1.0
    request.minimumSize = 0.25       // a wall fills the frame; ignore posters and outlets
    request.quadratureTolerance = 30 // walls shot from an angle are far from square
    request.minimumConfidence = 0.5
    request.maximumObservations = 1
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let r = request.results?.first, coverage(r) >= minimumCoverage else { return nil }
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
    // Labels are physical (see uprightLabels), so the corrected output is already upright.
    let upright = corrected
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

  struct RectifiedPhoto {
    let imagePath: String
    let aspect: Float // width / height of the face: metric when a focal length is known, else the image-space ratio
    let aspectIsMetric: Bool
    let detected: Bool
    let confidence: Float
  }

  /// Focal length in pixels for an image whose long edge is `longEdge`, from the photo's EXIF
  /// 35 mm-equivalent focal length. Nil for screenshots, edited exports and foreign files.
  private static func focalPx(path: String, longEdge: CGFloat) -> Double? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
          let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
          let f35 = exif[kCGImagePropertyExifFocalLenIn35mmFilm] as? Double, f35 > 0 else { return nil }
    return f35 / 36.0 * Double(longEdge) // 36 mm is the full-frame width along the long edge
  }

  /// Physical width / height of a rectangle seen under perspective (Zhang & He, "Whiteboard
  /// scanning and image enhancement"): a homography alone cannot give it, the focal length can.
  /// Corners in pixels with the principal point at the image centre; `f` in pixels, or nil to
  /// estimate it from the quad itself (only possible when the shot is not frontal).
  private static func metricAspect(tl: CGPoint, tr: CGPoint, br: CGPoint, bl: CGPoint, size: CGSize, f known: Double?) -> Double? {
    let w = Double(size.width), h = Double(size.height)
    let hom = { (p: CGPoint) in SIMD3<Double>(Double(p.x) - w / 2, Double(p.y) - h / 2, 1) }
    let m1 = hom(bl), m2 = hom(br), m3 = hom(tl), m4 = hom(tr)
    let d24 = simd_dot(simd_cross(m2, m4), m3), d34 = simd_dot(simd_cross(m3, m4), m2)
    guard abs(d24) > 1e-9, abs(d34) > 1e-9 else { return nil }
    let k2 = simd_dot(simd_cross(m1, m4), m3) / d24
    let k3 = simd_dot(simd_cross(m1, m4), m2) / d34
    let n2 = k2 * m2 - m1, n3 = k3 * m3 - m1
    var f = known
    if f == nil {
      let denom = n2.z * n3.z
      guard abs(denom) > 1e-9 else { return nil }
      let f2 = -(n2.x * n3.x + n2.y * n3.y) / denom
      guard f2 > 0, f2.isFinite else { return nil }
      f = f2.squareRoot()
    }
    guard let fpx = f, fpx > 1 else { return nil }
    let num = (n2.x * n2.x + n2.y * n2.y) / (fpx * fpx) + n2.z * n2.z
    let den = (n3.x * n3.x + n3.y * n3.y) / (fpx * fpx) + n3.z * n3.z
    guard den > 0, num > 0 else { return nil }
    let r = (num / den).squareRoot()
    return r.isFinite && r > 0.1 && r < 10 ? r : nil
  }

  /// The same four-point transform for a photo from the library (no ARKit, so no metres):
  /// upright it, find the face, straighten it. The rectified aspect ratio is the face's real
  /// width-to-height ratio, which is what turns one entered ceiling height into a room.
  static func rectifyLibraryPhoto(path: String) -> RectifiedPhoto? {
    guard let ui = UIImage(contentsOfFile: path) else { return nil }
    let longEdge = max(ui.size.width, ui.size.height)
    let scale = min(1, 2000 / max(longEdge, 1))
    let size = CGSize(width: ui.size.width * scale, height: ui.size.height * scale)
    let fmt = UIGraphicsImageRendererFormat.default(); fmt.scale = 1
    // Drawing through UIImage bakes in the EXIF orientation: the CGImage below is upright.
    let upright = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in ui.draw(in: CGRect(origin: .zero, size: size)) }
    guard let cg = upright.cgImage else { return nil }
    let detected = detect(in: cg)
    let quad = detected ?? fullFrame()
    let image = CIImage(cgImage: cg)
    let w = image.extent.width, h = image.extent.height
    let px = { (p: CGPoint) in CIVector(x: p.x * w, y: p.y * h) }
    guard let filter = CIFilter(name: "CIPerspectiveCorrection") else { return nil }
    filter.setValue(image, forKey: kCIInputImageKey)
    filter.setValue(px(quad.topLeft), forKey: "inputTopLeft")
    filter.setValue(px(quad.topRight), forKey: "inputTopRight")
    filter.setValue(px(quad.bottomRight), forKey: "inputBottomRight")
    filter.setValue(px(quad.bottomLeft), forKey: "inputBottomLeft")
    guard let corrected = filter.outputImage, corrected.extent.width > 1, corrected.extent.height > 1,
          let outCG = ciContext.createCGImage(corrected, from: corrected.extent),
          let data = UIImage(cgImage: outCG).jpegData(compressionQuality: 0.88) else { return nil }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("face-\(UUID().uuidString).jpg")
    do { try data.write(to: url) } catch { return nil }
    // Metric aspect when possible: EXIF focal length first, self-calibration from the quad
    // second (needs an angled shot); the image-space ratio last, flagged so the room builder
    // can say the size is only approximate.
    let pt = { (p: CGPoint) in CGPoint(x: p.x * w, y: p.y * h) }
    let known = focalPx(path: path, longEdge: max(w, h))
    let metric: Double? = detected == nil ? nil : (
      metricAspect(tl: pt(quad.topLeft), tr: pt(quad.topRight), br: pt(quad.bottomRight), bl: pt(quad.bottomLeft), size: CGSize(width: w, height: h), f: known)
      ?? metricAspect(tl: pt(quad.topLeft), tr: pt(quad.topRight), br: pt(quad.bottomRight), bl: pt(quad.bottomLeft), size: CGSize(width: w, height: h), f: nil)
    )
    return RectifiedPhoto(
      imagePath: url.path,
      aspect: Float(metric ?? Double(corrected.extent.width / corrected.extent.height)),
      aspectIsMetric: metric != nil,
      detected: detected != nil,
      confidence: quad.confidence
    )
  }

  /// World points for the four corners. First a raycast against the face's plane (detected
  /// plane geometry, then an estimated plane); when neither covers the corner — ceilings and
  /// featureless walls rarely get a plane — the LiDAR depth map is read directly at that pixel
  /// and unprojected. Nil only if a corner has no depth either: never a guessed corner.
  static func measure(frame: ARFrame, session: ARSession, quad: DetectedQuad, vertical: Bool) -> [SIMD3<Float>]? {
    var points: [SIMD3<Float>] = []
    for c in quad.corners {
      let imagePoint = CGPoint(x: c.x, y: 1 - c.y) // Vision bottom-left -> ARKit top-left
      let alignment: ARRaycastQuery.TargetAlignment = vertical ? .vertical : .horizontal
      var world: SIMD3<Float>?
      for target in [ARRaycastQuery.Target.existingPlaneGeometry, .estimatedPlane] {
        let query = frame.raycastQuery(from: imagePoint, allowing: target, alignment: alignment)
        if let h = session.raycast(query).first {
          let t = h.worldTransform.columns.3
          world = SIMD3(t.x, t.y, t.z)
          break
        }
      }
      if world == nil { world = unproject(frame: frame, imagePoint: imagePoint) }
      guard let world else { return nil }
      points.append(world)
    }
    return points
  }

  /// One image point (top-left normalised, raw buffer) to a world point through sceneDepth:
  /// median depth of a small window around the pixel, K⁻¹ scaled to the depth map's size, then
  /// the CV-to-ARKit axis flip — the same derivation as object-measure's DepthUnprojector.
  static func unproject(frame: ARFrame, imagePoint: CGPoint) -> SIMD3<Float>? {
    guard let depthData = frame.sceneDepth ?? frame.smoothedSceneDepth else { return nil }
    let map = depthData.depthMap
    let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map)
    let col = min(max(Int(imagePoint.x * CGFloat(w)), 0), w - 1)
    let row = min(max(Int(imagePoint.y * CGFloat(h)), 0), h - 1)

    CVPixelBufferLockBaseAddress(map, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
    let stride = CVPixelBufferGetBytesPerRow(map)
    var samples: [Float] = []
    for dr in -3...3 {
      for dc in -3...3 {
        let r = row + dr, c = col + dc
        guard r >= 0, r < h, c >= 0, c < w else { continue }
        let z = base.advanced(by: r * stride).assumingMemoryBound(to: Float32.self)[c]
        if z.isFinite, z > 0.05 { samples.append(z) }
      }
    }
    guard samples.count >= 5 else { return nil }
    samples.sort()
    let z = samples[samples.count / 2]

    let k = frame.camera.intrinsics
    let res = frame.camera.imageResolution
    let sx = Float(w) / Float(res.width), sy = Float(h) / Float(res.height)
    let fx = k[0][0] * sx, fy = k[1][1] * sy, cx = k[2][0] * sx, cy = k[2][1] * sy
    let x = (Float(col) - cx) / fx * z
    let y = (Float(row) - cy) / fy * z
    let local = SIMD4<Float>(x, -y, -z, 1) // CV (Y down, Z forward) -> ARKit camera (Y up, Z back)
    let wp = frame.camera.transform * local
    return SIMD3(wp.x, wp.y, wp.z)
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
