import ARKit
import CoreImage
import UIKit
import simd

// The four cheap things plan section 1 asks for before a captured frame gets
// uploaded: crop to the measured object, score sharpness, (exposure/white
// balance locking lives in ObjectMeasureController, since it is a capture
// device setting, not a per-frame transform), and the light estimate (also
// read directly off the frame in the controller).
enum ObjectFrameProcessor {
  private static let ciContext = CIContext()

  // Project the measured box's 8 corners and crop to their 2D hull, padded
  // 10%. Deliberately projects and crops in the SAME orientation and
  // viewport as the raw capturedImage buffer (landscape, imageResolution) —
  // projecting for one orientation and cropping in another is the classic
  // silent 90-degree bug the plan calls out for the alternative (crop-first)
  // design. Any rotation to portrait for human viewing is a separate,
  // later step, never folded into this math.
  static func croppedImage(
    frame: ARFrame,
    measurement: ObjectMeasurement
  ) -> CGImage? {
    let corners = worldCorners(of: measurement)
    let viewport = frame.camera.imageResolution

    let projected = corners.compactMap { corner -> CGPoint? in
      frame.camera.projectPoint(corner, orientation: .landscapeRight, viewportSize: viewport)
    }
    guard !projected.isEmpty else { return nil }

    let minX = projected.map(\.x).min() ?? 0
    let maxX = projected.map(\.x).max() ?? viewport.width
    let minY = projected.map(\.y).min() ?? 0
    let maxY = projected.map(\.y).max() ?? viewport.height

    let padX = (maxX - minX) * 0.10
    let padY = (maxY - minY) * 0.10
    let cropRect = CGRect(
      x: max(0, minX - padX),
      y: max(0, minY - padY),
      width: min(viewport.width, maxX - minX + padX * 2),
      height: min(viewport.height, maxY - minY + padY * 2)
    )
    guard cropRect.width > 1, cropRect.height > 1 else { return nil }

    let ciImage = CIImage(cvPixelBuffer: frame.capturedImage)
    // CVPixelBuffer-backed CIImage has a bottom-left origin; imageResolution
    // coordinates from projectPoint have a top-left origin. Flip Y once.
    let flippedRect = CGRect(
      x: cropRect.minX,
      y: viewport.height - cropRect.maxY,
      width: cropRect.width,
      height: cropRect.height
    )
    let cropped = ciImage.cropped(to: flippedRect)
    return ciContext.createCGImage(cropped, from: cropped.extent)
  }

  // The 8 corners of the measured oriented box, in world space.
  private static func worldCorners(of m: ObjectMeasurement) -> [simd_float3] {
    let theta = m.yawDeg * .pi / 180
    let cosT = cos(theta)
    let sinT = sin(theta)
    let hw = m.widthMeters / 2
    let hd = m.depthMeters / 2

    var corners: [simd_float3] = []
    for sx in [-hw, hw] {
      for sz in [-hd, hd] {
        // Rotate the local (sx, sz) offset by the fitted yaw (R_y(theta) —
        // see MinimumAreaRectangle.swift for the derivation) back to world.
        let worldX = m.centerWorld.x + sx * cosT + sz * sinT
        let worldZ = m.centerWorld.z - sx * sinT + sz * cosT
        for y in [m.centerWorld.y - m.heightMeters / 2, m.centerWorld.y + m.heightMeters / 2] {
          corners.append(simd_float3(worldX, y, worldZ))
        }
      }
    }
    return corners
  }

  // Variance of the Laplacian, the standard cheap blur score: a sharp image
  // has more high-frequency edge content, so the Laplacian's variance is
  // higher. Downscales first — this only needs to rank candidate frames
  // against each other, not measure absolute sharpness.
  static func sharpnessScore(_ image: CGImage) -> Double {
    guard let context = CGContext(
      data: nil,
      width: 128,
      height: 128 * image.height / max(image.width, 1),
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceGray(),
      bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return 0 }

    context.draw(image, in: CGRect(x: 0, y: 0, width: context.width, height: context.height))
    guard let data = context.data else { return 0 }
    let pixels = data.bindMemory(to: UInt8.self, capacity: context.width * context.height)

    var sum = 0.0
    var sumSquares = 0.0
    var count = 0
    for y in 1..<(context.height - 1) {
      for x in 1..<(context.width - 1) {
        let center = Int(pixels[y * context.width + x])
        let up = Int(pixels[(y - 1) * context.width + x])
        let down = Int(pixels[(y + 1) * context.width + x])
        let left = Int(pixels[y * context.width + x - 1])
        let right = Int(pixels[y * context.width + x + 1])
        let laplacian = Double(up + down + left + right - 4 * center)
        sum += laplacian
        sumSquares += laplacian * laplacian
        count += 1
      }
    }
    guard count > 0 else { return 0 }
    let mean = sum / Double(count)
    return sumSquares / Double(count) - mean * mean
  }

  static func writeJPEG(_ image: CGImage, quality: CGFloat = 0.85) -> URL? {
    let uiImage = UIImage(cgImage: image)
    guard let data = uiImage.jpegData(compressionQuality: quality) else { return nil }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("jpg")
    do {
      try data.write(to: url)
      return url
    } catch {
      return nil
    }
  }
}
