import Foundation
import RoomPlan
import simd

// Maps a RoomPlan CapturedRoom to RoomCapture v1 (.claude/contracts.md) by
// hand. We never ship Apple's synthesised Codable encoding of CapturedRoom —
// its field names and nesting are not the contract, and it drifts across
// OS versions with no notice to us.
enum RoomCaptureSerializer {
  static let schemaVersion = 1

  static func serialize(_ room: CapturedRoom, northBearingDeg: Double) -> [String: Any] {
    [
      "schemaVersion": schemaVersion,
      "roomId": UUID().uuidString,
      "capturedAt": ISO8601DateFormatter().string(from: Date()),
      "worldAlignment": "gravityAndHeading",
      "northBearingDeg": northBearingDeg,
      "floor": serializeFloor(room),
      "walls": room.walls.map(serializeWall),
      "openings": serializeOpenings(room),
      "objects": room.objects.map(serializeObject),
    ]
  }

  // MARK: - Walls

  private static func serializeWall(_ surface: CapturedRoom.Surface) -> [String: Any] {
    [
      "id": surface.identifier.uuidString,
      "transform": flatten(surface.transform),
      "dimensions": [surface.dimensions.x, surface.dimensions.y, surface.dimensions.z],
      "confidence": confidenceName(surface.confidence),
    ]
  }

  // MARK: - Openings

  private static func serializeOpenings(_ room: CapturedRoom) -> [[String: Any]] {
    (room.doors + room.windows + room.openings).compactMap { surface in
      guard let kind = openingKind(surface.category) else { return nil }
      return [
        "id": surface.identifier.uuidString,
        "kind": kind,
        "wallId": surface.parentIdentifier?.uuidString ?? "",
        "transform": flatten(surface.transform),
        // contracts.md's fixture hardcodes 0 for the third dimension on every
        // opening — an opening is a hole, not a volume, regardless of the
        // real wall thickness Surface.dimensions.z would report.
        "dimensions": [surface.dimensions.x, surface.dimensions.y, 0],
        // ceiling: RoomPlan gives no hinge-side or swing-angle detection.
        // Surface.Category.door(isOpen:) is the only door-specific signal —
        // flattened deliberately below, since isOpen has no field in the
        // schema. "unknown" is a real value the schema defines for exactly
        // this gap; 90 is the standard interior door swing, not a
        // measurement. Door swing is deprioritized for this component (plan
        // section 11) — a real detector, if one is ever built, belongs in
        // Justin's fit engine.
        "hingeSide": "unknown",
        "swingDeg": kind == "door" ? 90 : 0,
      ]
    }
  }

  // Surface.Category.door(isOpen:) carries an associated value we deliberately
  // drop — matching on `.door` without binding `isOpen` is the flattening.
  private static func openingKind(_ category: CapturedRoom.Surface.Category) -> String? {
    switch category {
    case .door: return "door"
    case .window: return "window"
    case .opening: return "opening"
    case .wall, .floor: return nil
    @unknown default: return nil
    }
  }

  // MARK: - Objects

  private static func serializeObject(_ object: CapturedRoom.Object) -> [String: Any] {
    [
      "id": object.identifier.uuidString,
      "category": categoryName(object.category),
      "transform": flatten(object.transform),
      "dimensions": [object.dimensions.x, object.dimensions.y, object.dimensions.z],
      "confidence": confidenceName(object.confidence),
    ]
  }

  private static func categoryName(_ category: CapturedRoom.Object.Category) -> String {
    switch category {
    case .bathtub: return "bathtub"
    case .bed: return "bed"
    case .chair: return "chair"
    case .dishwasher: return "dishwasher"
    case .fireplace: return "fireplace"
    case .oven: return "oven"
    case .refrigerator: return "refrigerator"
    case .sink: return "sink"
    case .sofa: return "sofa"
    case .stairs: return "stairs"
    case .storage: return "storage"
    case .stove: return "stove"
    case .table: return "table"
    case .television: return "television"
    case .toilet: return "toilet"
    case .washerDryer: return "washerDryer"
    @unknown default: return "storage"
    }
  }

  // MARK: - Floor

  private static func serializeFloor(_ room: CapturedRoom) -> [String: Any] {
    let polygon = floorPolygon(room)
    return [
      "polygon": polygon.map { [Double($0.x), Double($0.y)] },
      "areaM2": Double(polygonArea(polygon)),
    ]
  }

  // ceiling: prefers CapturedRoom.floors (iOS 17+) — a real per-story
  // polygon from RoomPlan itself. Falls back to the convex hull of every
  // wall's own base midpoint when no floor surface was detected. That is a
  // real geometric derivation from the same scan, not a guessed value, for
  // the rare room where floor detection fails; contracts.md has no
  // "unmeasured" state for `floor`, so this is the honest fallback rather
  // than blocking the whole capture on one missing surface.
  private static func floorPolygon(_ room: CapturedRoom) -> [SIMD2<Float>] {
    if !room.floors.isEmpty {
      return room.floors.flatMap { floor in
        floor.polygonCorners.map { corner -> SIMD2<Float> in
          let world = floor.transform * SIMD4<Float>(corner.x, corner.y, corner.z, 1)
          return SIMD2(world.x, world.z)
        }
      }
    }
    let basePoints = room.walls.map { wall -> SIMD2<Float> in
      // Wall transforms are centred on the wall (contracts.md's own fixture
      // has translation.y == dimensions[1] / 2), so -height/2 in local space
      // is the wall's own floor-level midpoint.
      let local = SIMD4<Float>(0, -wall.dimensions.y / 2, 0, 1)
      let world = wall.transform * local
      return SIMD2(world.x, world.z)
    }
    return convexHull(basePoints)
  }

  private static func polygonArea(_ points: [SIMD2<Float>]) -> Float {
    guard points.count >= 3 else { return 0 }
    var sum: Float = 0
    for i in 0..<points.count {
      let a = points[i]
      let b = points[(i + 1) % points.count]
      sum += a.x * b.y - b.x * a.y
    }
    return abs(sum) / 2
  }

  // Andrew's monotone chain.
  private static func convexHull(_ pointsIn: [SIMD2<Float>]) -> [SIMD2<Float>] {
    let points = pointsIn.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
    guard points.count >= 3 else { return points }

    func cross(_ o: SIMD2<Float>, _ a: SIMD2<Float>, _ b: SIMD2<Float>) -> Float {
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
    }

    var lower: [SIMD2<Float>] = []
    for p in points {
      while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], p) <= 0 {
        lower.removeLast()
      }
      lower.append(p)
    }
    var upper: [SIMD2<Float>] = []
    for p in points.reversed() {
      while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], p) <= 0 {
        upper.removeLast()
      }
      upper.append(p)
    }
    lower.removeLast()
    upper.removeLast()
    return lower + upper
  }

  // MARK: - Shared

  private static func confidenceName(_ confidence: CapturedRoom.Confidence) -> String {
    switch confidence {
    case .high: return "high"
    case .medium: return "medium"
    case .low: return "low"
    @unknown default: return "low"
    }
  }

  static func instructionName(_ instruction: RoomCaptureSession.Instruction) -> String {
    switch instruction {
    case .normal: return "normal"
    case .moveCloseToWall: return "moveCloseToWall"
    case .moveAwayFromWall: return "moveAwayFromWall"
    case .turnOnLight: return "turnOnLight"
    case .slowDown: return "slowDown"
    case .lowTexture: return "lowTexture"
    @unknown default: return "normal"
    }
  }

  // contracts.md: "16 floats, column-major. This matches simd_float4x4
  // memory order" — so a straight column-by-column read is correct with no
  // transpose.
  private static func flatten(_ m: simd_float4x4) -> [Float] {
    [
      m.columns.0.x, m.columns.0.y, m.columns.0.z, m.columns.0.w,
      m.columns.1.x, m.columns.1.y, m.columns.1.z, m.columns.1.w,
      m.columns.2.x, m.columns.2.y, m.columns.2.z, m.columns.2.w,
      m.columns.3.x, m.columns.3.y, m.columns.3.z, m.columns.3.w,
    ]
  }
}
