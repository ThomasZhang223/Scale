import ARKit
import UIKit
import CoreVideo
import simd

struct ObjectSeed {
  let point: simd_float3
  let planeY: Float
}

struct ObjectMeasurement {
  let widthMeters: Float
  let heightMeters: Float
  let depthMeters: Float
  let yawDeg: Float
  let centerWorld: simd_float3
  let survivingSampleCount: Int
  let totalSampleCount: Int
  // Every surviving sample, for the point-cloud ghost (plan section 1).
  let points: [simd_float3]
}

// The raycast-and-grow measurement, no machine learning. Runs once per
// ARFrame; ObjectMeasureController runs it over 8-10 frames and takes the
// median (see that file).
enum ObjectMeasurer {
  // plan section 1: "Under about 150 surviving samples, return unmeasured
  // rather than a number." Fail loud — never a number built from too little.
  static let minimumSurvivingSamples = 150

  // One raycast at the moment of the tap. Reused as the seed for every
  // subsequent frame in the sweep: the object does not move, only the depth
  // samples around it change frame to frame, which is exactly what taking a
  // median across frames is for.
  //
  // The tap arrives normalised to the portrait *view*. ARFrame.raycastQuery
  // wants normalised *image* coordinates — the landscape camera buffer, which
  // the view shows rotated and aspect-filled. Feeding a view point straight
  // in lands the seed a quarter turn away from the finger: the first on-device
  // measurement of a cap put its box on the empty table behind it. The
  // display transform is Apple's own map from image to view for this
  // orientation and aspect; its inverse is the one we need.
  static func raycastSeed(
    session: ARSession,
    frame: ARFrame,
    normalizedTapPoint: CGPoint,
    viewSize: CGSize
  ) -> ObjectSeed? {
    // No guessed viewport: a wrong size puts the box a quarter turn from the finger. The caller
    // turns nil into ObjectMeasureError.raycastFailed.
    guard viewSize.width > 0, viewSize.height > 0 else { return nil }
    let size = viewSize
    let imagePoint = normalizedTapPoint.applying(
      frame.displayTransform(for: .portrait, viewportSize: size).inverted()
    )
    let query = frame.raycastQuery(
      from: imagePoint,
      allowing: .estimatedPlane,
      alignment: .horizontal
    )
    guard let hit = session.raycast(query).first else { return nil }
    let t = hit.worldTransform.columns.3
    return ObjectSeed(point: simd_float3(t.x, t.y, t.z), planeY: t.y)
  }

  static func measure(frame: ARFrame, seed: ObjectSeed) -> ObjectMeasurement? {
    // Gate on tracking, not on brightness (plan section 1): sceneDepth is
    // fine in the dark, but a bad pose makes every unprojected point garbage
    // regardless of how the frame looks.
    guard frame.camera.trackingState == .normal else { return nil }
    guard let depthData = frame.sceneDepth else { return nil }

    let allPoints = extractPoints(frame: frame, depthData: depthData)
    guard let fitted = growAndFit(allPoints: allPoints, seed: seed) else { return nil }
    guard fitted.points.count >= minimumSurvivingSamples else { return nil }
    return fitted
  }

  // MARK: - Step 1 of the plan's list is the raycast above. This is step 2:
  // build the full candidate point set once, filtered only by confidence
  // (the height and radius predicates are applied over and over below, on
  // this same array, in memory).

  private static func extractPoints(frame: ARFrame, depthData: ARDepthData) -> [simd_float3] {
    let depthMap = depthData.depthMap
    let confidenceMap = depthData.confidenceMap
    let width = CVPixelBufferGetWidth(depthMap)
    let height = CVPixelBufferGetHeight(depthMap)
    let intrinsics = DepthUnprojector.scaledIntrinsics(frame, depthSize: (width, height))
    let cameraTransform = frame.camera.transform

    CVPixelBufferLockBaseAddress(depthMap, .readOnly)
    if let confidenceMap { CVPixelBufferLockBaseAddress(confidenceMap, .readOnly) }
    defer {
      CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
      if let confidenceMap { CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly) }
    }

    guard let depthBase = CVPixelBufferGetBaseAddress(depthMap) else { return [] }
    let depthBytesPerRow = CVPixelBufferGetBytesPerRow(depthMap)
    let confidenceBase = confidenceMap.flatMap { CVPixelBufferGetBaseAddress($0) }
    let confidenceBytesPerRow = confidenceMap.map { CVPixelBufferGetBytesPerRow($0) } ?? 0

    var points: [simd_float3] = []
    points.reserveCapacity(width * height)

    for row in 0..<height {
      let depthRow = depthBase
        .advanced(by: row * depthBytesPerRow)
        .assumingMemoryBound(to: Float32.self)
      let confidenceRow = confidenceBase?
        .advanced(by: row * confidenceBytesPerRow)
        .assumingMemoryBound(to: UInt8.self)

      for col in 0..<width {
        // Predicate 1: confidence == .high, before anything else.
        if let confidenceRow, ARConfidenceLevel(rawValue: Int(confidenceRow[col])) != .high {
          continue
        }
        guard let world = DepthUnprojector.worldPoint(
          row: row,
          col: col,
          depthMeters: depthRow[col],
          intrinsics: intrinsics,
          cameraTransform: cameraTransform
        ) else { continue }
        points.append(world)
      }
    }
    return points
  }

  // MARK: - Steps 3-4: grow the radius, re-filtering the in-memory array
  // each time, then fit the minimum-area rectangle.

  private static func growAndFit(allPoints: [simd_float3], seed: ObjectSeed) -> ObjectMeasurement? {
    var radius: Float = 0.20
    var filtered = filterByHeightAndRadius(allPoints, seed: seed, radius: radius)

    for _ in 0..<3 {
      guard let rect = MinimumAreaRectangleFitter.fit(points: filtered.map { SIMD2($0.x, $0.z) }) else {
        break
      }
      let halfExtent = max(rect.width, rect.depth) / 2
      let candidateRadius = min(halfExtent * 1.25, radius * 1.5)
      let grown = filterByHeightAndRadius(allPoints, seed: seed, radius: candidateRadius)

      // Annulus density test: the ring between the old and new radius. Under
      // ~3% of what was already inside means we have reached empty table.
      let ringCount = grown.count - filtered.count
      let ringDensity = filtered.isEmpty ? 1 : Float(ringCount) / Float(filtered.count)
      radius = candidateRadius
      filtered = grown
      if ringDensity < 0.03 { break }
    }

    guard let finalRect = MinimumAreaRectangleFitter.fit(points: filtered.map { SIMD2($0.x, $0.z) }) else {
      return nil
    }
    let heights = filtered.map(\.y)
    guard let minY = heights.min(), let maxY = heights.max() else { return nil }

    return ObjectMeasurement(
      widthMeters: finalRect.width,
      heightMeters: maxY - minY,
      depthMeters: finalRect.depth,
      yawDeg: finalRect.yawDeg,
      centerWorld: simd_float3(finalRect.centerX, (minY + maxY) / 2, finalRect.centerZ),
      survivingSampleCount: filtered.count,
      totalSampleCount: allPoints.count,
      points: filtered
    )
  }

  // Predicates 2-4: strictly above the support plane (excludes the table
  // itself and its legs), below a ceiling height cap (excludes the room's
  // ceiling and wall tops), and within the current horizontal radius.
  private static func filterByHeightAndRadius(
    _ points: [simd_float3],
    seed: ObjectSeed,
    radius: Float
  ) -> [simd_float3] {
    let radiusSquared = radius * radius
    return points.filter { p in
      guard p.y > seed.planeY + 0.015 else { return false }
      guard p.y - seed.planeY < 1.2 else { return false }
      let dx = p.x - seed.point.x
      let dz = p.z - seed.point.z
      return dx * dx + dz * dz <= radiusSquared
    }
  }
}
