import simd

struct MinimumAreaRectangle {
  let centerX: Float
  let centerZ: Float
  let width: Float // extent along the fitted rectangle's own local X
  let depth: Float // extent along the fitted rectangle's own local Z
  let yawDeg: Float // contracts.md convention: degrees, CCW seen from +Y
}

enum MinimumAreaRectangleFitter {
  // A world-axis box overestimates a rotated object by up to 41% (plan
  // section 1) — this is the fix. Sweep 90 angles at one-degree steps, and
  // for each candidate yaw, express the points in that candidate's local
  // frame and take the AABB; keep the smallest area.
  //
  // Angle convention (contracts.md: "degrees, CCW seen from +Y", i.e. an
  // observer above the room looking down): a positive rotation about +Y
  // carries world +Z toward world +X. So the rotation that expresses a
  // world point in a frame yawed by `theta` is R_y(-theta):
  //   localX = x*cos(theta) - z*sin(theta)
  //   localZ = x*sin(theta) + z*cos(theta)
  // and its inverse, R_y(theta), converts a local point back to world:
  //   worldX = localX*cos(theta) + localZ*sin(theta)
  //   worldZ = -localX*sin(theta) + localZ*cos(theta)
  // Get this backwards and every measured object's yaw comes out mirrored —
  // width and depth still look right, but a corner-cropped RGB frame (which
  // uses this yaw to project the box) would be rotated the wrong way. Cheap
  // to check: fit a rectangle known to be at 0 deg and at 45 deg and confirm
  // the sign, before trusting it against a real device.
  static func fit(points: [SIMD2<Float>]) -> MinimumAreaRectangle? {
    guard points.count >= 3 else { return nil }

    var best: MinimumAreaRectangle?
    var bestArea = Float.greatestFiniteMagnitude

    for degrees in stride(from: 0, to: 90, by: 1) {
      let theta = Float(degrees) * .pi / 180
      let cosT = cos(theta)
      let sinT = sin(theta)

      var minX = Float.greatestFiniteMagnitude
      var maxX = -Float.greatestFiniteMagnitude
      var minZ = Float.greatestFiniteMagnitude
      var maxZ = -Float.greatestFiniteMagnitude

      for p in points {
        let localX = p.x * cosT - p.y * sinT
        let localZ = p.x * sinT + p.y * cosT
        minX = min(minX, localX)
        maxX = max(maxX, localX)
        minZ = min(minZ, localZ)
        maxZ = max(maxZ, localZ)
      }

      let width = maxX - minX
      let depth = maxZ - minZ
      let area = width * depth
      guard area < bestArea else { continue }

      let localCenterX = (minX + maxX) / 2
      let localCenterZ = (minZ + maxZ) / 2
      let worldCenterX = localCenterX * cosT + localCenterZ * sinT
      let worldCenterZ = -localCenterX * sinT + localCenterZ * cosT

      bestArea = area
      best = MinimumAreaRectangle(
        centerX: worldCenterX,
        centerZ: worldCenterZ,
        width: width,
        depth: depth,
        yawDeg: Float(degrees)
      )
    }

    return best
  }
}
