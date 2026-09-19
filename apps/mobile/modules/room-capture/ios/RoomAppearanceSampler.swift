import ARKit
import CoreGraphics
import simd

// Appearance step 1 only (contracts.md's optional `appearance` field):
// sample a dominant colour per wall, floor, and — only where a buffered
// frame actually shows it — ceiling. `textureUrl` is always null here;
// per-wall rectified photos are plan section 4b step 3, out of scope unless
// Component A is ahead at H16.
//
// Untested on a real device, same as the rest of this file's projection
// math — see modules/room-capture/README.md.
enum RoomAppearanceSampler {
  static func sample(room: CapturedRoom, frames: [RoomFrameSample]) -> [String: Any]? {
    guard !frames.isEmpty else { return nil }

    var surfaces: [String: [String: Any]] = [:]

    for wall in room.walls {
      let center = simd_float3(
        wall.transform.columns.3.x, wall.transform.columns.3.y, wall.transform.columns.3.z
      )
      if let hex = sampleColor(atWorldPoint: center, frames: frames) {
        surfaces[wall.identifier.uuidString] = ["hex": hex, "textureUrl": NSNull()]
      }
    }

    if let floorHex = floorColor(room: room, frames: frames) {
      surfaces["floor"] = ["hex": floorHex, "textureUrl": NSNull()]
    }

    // RoomPlan has no ceiling category at all (Surface.Category is floor,
    // door, opening, wall, window — no ceiling). This is the only surface
    // we can ever fail to report, and that is correct: omit rather than
    // guess when no buffered frame looked up.
    if let ceilingHex = samplePitchedRegion(frames: frames, wantDownward: false) {
      surfaces["ceiling"] = ["hex": ceilingHex, "textureUrl": NSNull()]
    }

    guard !surfaces.isEmpty else { return nil }
    return ["surfaces": surfaces]
  }

  private static func floorColor(room: CapturedRoom, frames: [RoomFrameSample]) -> String? {
    if let floor = room.floors.first {
      let center = simd_float3(
        floor.transform.columns.3.x, floor.transform.columns.3.y, floor.transform.columns.3.z
      )
      if let hex = sampleColor(atWorldPoint: center, frames: frames) {
        return hex
      }
    }
    return samplePitchedRegion(frames: frames, wantDownward: true)
  }

  // MARK: - Projection

  private static func sampleColor(atWorldPoint point: simd_float3, frames: [RoomFrameSample]) -> String? {
    var best: (frame: RoomFrameSample, pixel: CGPoint, distanceToCenter: CGFloat)?

    for frame in frames {
      guard let image = frame.image else { continue }
      guard let pixel = project(point, frame: frame) else { continue }
      guard pixel.x >= 0, pixel.y >= 0, pixel.x < CGFloat(image.width), pixel.y < CGFloat(image.height) else {
        continue
      }
      let dx = pixel.x - CGFloat(image.width) / 2
      let dy = pixel.y - CGFloat(image.height) / 2
      let distance = (dx * dx + dy * dy).squareRoot()
      if best == nil || distance < best!.distanceToCenter {
        best = (frame, pixel, distance)
      }
    }

    guard let best, let image = best.frame.image else { return nil }
    return averageColorHex(image: image, around: best.pixel)
  }

  // The inverse of modules/object-measure's DepthUnprojector.worldPoint —
  // see that file for the CV-versus-ARKit axis-convention derivation this
  // mirrors in reverse: world -> ARKit-local -> CV-local -> pixel.
  private static func project(_ worldPoint: simd_float3, frame: RoomFrameSample) -> CGPoint? {
    guard let image = frame.image else { return nil }
    let local4 = frame.transform.inverse * simd_float4(worldPoint.x, worldPoint.y, worldPoint.z, 1)
    let cv = simd_float3(local4.x, -local4.y, -local4.z)
    guard cv.z > 0 else { return nil } // behind the camera

    // frame.intrinsics is calibrated for frame.imageResolution (the
    // original, full-size frame), not the downscaled `image` actually
    // stored — rescale exactly like DepthUnprojector.scaledIntrinsics.
    let scaleX = Float(image.width) / Float(frame.imageResolution.width)
    let scaleY = Float(image.height) / Float(frame.imageResolution.height)
    var k = frame.intrinsics
    k[0][0] *= scaleX
    k[2][0] *= scaleX
    k[1][1] *= scaleY
    k[2][1] *= scaleY

    let projected = k * cv
    guard projected.z != 0 else { return nil }
    return CGPoint(x: CGFloat(projected.x / projected.z), y: CGFloat(projected.y / projected.z))
  }

  private static func averageColorHex(image: CGImage, around point: CGPoint, patch: Int = 12) -> String? {
    let rect = CGRect(x: Int(point.x) - patch / 2, y: Int(point.y) - patch / 2, width: patch, height: patch)
      .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
    guard rect.width > 0, rect.height > 0, let cropped = image.cropping(to: rect) else { return nil }
    guard let data = cropped.dataProvider?.data, let ptr = CFDataGetBytePtr(data) else { return nil }

    let bytesPerPixel = max(cropped.bitsPerPixel / 8, 1)
    let bytesPerRow = cropped.bytesPerRow
    let length = CFDataGetLength(data)
    var rSum = 0, gSum = 0, bSum = 0, count = 0

    for row in 0..<cropped.height {
      for col in 0..<cropped.width {
        let offset = row * bytesPerRow + col * bytesPerPixel
        guard offset + 2 < length else { continue }
        rSum += Int(ptr[offset])
        gSum += Int(ptr[offset + 1])
        bSum += Int(ptr[offset + 2])
        count += 1
      }
    }
    guard count > 0 else { return nil }
    return String(format: "#%02x%02x%02x", rSum / count, gSum / count, bSum / count)
  }

  // Last resort, used when no RoomPlan surface exists to project (always
  // true for the ceiling, sometimes true for the floor): pick whichever
  // buffered frame pitched most steeply up or down, and average a patch at
  // that end of the image.
  private static func samplePitchedRegion(frames: [RoomFrameSample], wantDownward: Bool) -> String? {
    var best: RoomFrameSample?
    // ceiling: only accept a meaningfully tilted frame. Below this, "top of
    // frame" is just more wall, not ceiling. Untuned — a real number needs a
    // device.
    var bestPitch: Float = 0.35

    for frame in frames {
      // ARKit camera convention: the camera looks down its own local -Z.
      let forward = -simd_float3(
        frame.transform.columns.2.x, frame.transform.columns.2.y, frame.transform.columns.2.z
      )
      let pitch = wantDownward ? -forward.y : forward.y
      if pitch > bestPitch {
        bestPitch = pitch
        best = frame
      }
    }

    guard let best, let image = best.image else { return nil }
    let y = wantDownward ? image.height - image.height / 10 : image.height / 10
    return averageColorHex(
      image: image,
      around: CGPoint(x: image.width / 2, y: y),
      patch: image.width / 4
    )
  }
}
