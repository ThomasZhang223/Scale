import ARKit
import CoreVideo
import simd

// Converts one sceneDepth pixel into a world-space point. This is the one
// piece of this module most worth checking on a real device first — see
// "VERIFY FIRST" below and modules/object-measure/README.md.
enum DepthUnprojector {
  // plan section 1, "Rescale the intrinsics": ARFrame.camera.intrinsics is
  // calibrated for camera.imageResolution (the full RGB frame), not for the
  // depth map's own, smaller resolution. There is no Apple helper for this.
  static func scaledIntrinsics(_ frame: ARFrame, depthSize: (width: Int, height: Int)) -> simd_float3x3 {
    let k = frame.camera.intrinsics
    let imageResolution = frame.camera.imageResolution
    let scaleX = Float(depthSize.width) / Float(imageResolution.width)
    let scaleY = Float(depthSize.height) / Float(imageResolution.height)

    var scaled = k
    scaled[0][0] *= scaleX // fx
    scaled[2][0] *= scaleX // cx
    scaled[1][1] *= scaleY // fy
    scaled[2][1] *= scaleY // cy
    return scaled
  }

  // VERIFY FIRST, on a real device, before trusting any measurement this
  // module produces: point the phone at a flat wall at 1 m (plan section 1).
  // If the reconstructed points do not form a flat, forward-facing plane,
  // the bug is here, in the axis convention below, not in the filtering or
  // rectangle fit.
  //
  // `intrinsics` describes a standard computer-vision pinhole camera: X
  // right, Y down, Z forward (positive, into the scene) — the same
  // convention as the captured image's own pixel buffer. `ARCamera.transform`
  // instead expects ARKit's rendering convention: X right, Y up, Z backward
  // (the camera looks down its own -Z). Unprojecting through K⁻¹ gives a
  // point in the first convention; converting to the second is a Y and Z
  // sign flip, not a no-op.
  static func worldPoint(
    row: Int,
    col: Int,
    depthMeters: Float,
    intrinsics: simd_float3x3,
    cameraTransform: simd_float4x4
  ) -> simd_float3? {
    guard depthMeters.isFinite, depthMeters > 0 else { return nil }

    let inv = intrinsics.inverse
    let pixel = simd_float3(Float(col), Float(row), 1)
    let cv = inv * pixel * depthMeters // X right, Y down, Z forward — CV convention

    let local = simd_float4(cv.x, -cv.y, -cv.z, 1) // flip into ARKit's local camera space
    let world = cameraTransform * local
    return simd_float3(world.x, world.y, world.z)
  }
}
