import ARKit
import CoreGraphics
import CoreImage

// One ring-buffered sample from the room sweep: pose, intrinsics, and a
// downscaled frame. Plan section 8 (per-wall rectified photos) needs exactly
// this later; capturing it now costs nothing because the sweep is already
// running this ARSession for RoomPlan. Building the rectifier itself is out
// of scope for this pass — see modules/room-capture/README.md.
struct RoomFrameSample {
  let transform: simd_float4x4
  let intrinsics: simd_float3x3
  let imageResolution: CGSize
  let image: CGImage?
}

enum RoomFrameSampler {
  private static let ciContext = CIContext()
  // Plan section 4b step 3: "downscaled to roughly 1440 px".
  private static let targetWidth: CGFloat = 1440

  static func sample(from frame: ARFrame) -> RoomFrameSample {
    let ciImage = CIImage(cvPixelBuffer: frame.capturedImage)
    let scale = targetWidth / ciImage.extent.width
    let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let cgImage = ciContext.createCGImage(scaled, from: scaled.extent)

    return RoomFrameSample(
      transform: frame.camera.transform,
      intrinsics: frame.camera.intrinsics,
      imageResolution: frame.camera.imageResolution,
      image: cgImage
    )
  }
}
