import ExpoModulesCore
import RealityKit
import simd

// Camera passthrough plus two overlays: the measured-box wireframe (plan
// section 5, "the visible claim that the size is real"), and the point-cloud
// ghost while the mesh generates (plan section 1). Shares
// ObjectMeasureController's ARSession; does not run its own.
//
// Lower confidence than the rest of this module: the point-cloud entity
// leans on RealityKit's MeshDescriptor point-primitive API, which is real
// but was not re-verified against live Apple docs this session the way the
// RoomPlan APIs were (see modules/room-capture's README). If it throws,
// `showGhost` fails silently rather than crashing — a missing decorative
// effect carries no decision weight; a wrong bboxMeters would.
class ObjectMeasureNativeView: ExpoView {
  private let arView = ARView(frame: .zero)
  private var boxEntity: ModelEntity?
  private var ghostEntity: ModelEntity?
  private let anchor = AnchorEntity(world: .zero)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    arView.session = ObjectMeasureController.shared.arSession
    arView.automaticallyConfigureSession = false
    arView.scene.addAnchor(anchor)
    addSubview(arView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    arView.frame = bounds
  }

  func showWireframeBox(
    center: SIMD3<Float>,
    widthMeters: Float,
    heightMeters: Float,
    depthMeters: Float,
    yawDeg: Float
  ) {
    boxEntity?.removeFromParent()
    let mesh = MeshResource.generateBox(
      width: widthMeters,
      height: heightMeters,
      depth: depthMeters
    )
    var material = UnlitMaterial(color: .white.withAlphaComponent(0.9))
    material.triangleFillMode = .lines
    let entity = ModelEntity(mesh: mesh, materials: [material])
    entity.position = center
    entity.orientation = simd_quatf(angle: yawDeg * .pi / 180, axis: [0, 1, 0])
    anchor.addChild(entity)
    boxEntity = entity
  }

  func showGhost(points: [SIMD3<Float>]) {
    ghostEntity?.removeFromParent()
    guard !points.isEmpty else { return }

    var descriptor = MeshDescriptor(name: "objectGhost")
    descriptor.positions = MeshBuffer(points)
    descriptor.primitives = .points(Array(0..<UInt32(points.count)))

    do {
      let mesh = try MeshResource.generate(from: [descriptor])
      var material = UnlitMaterial(color: .cyan.withAlphaComponent(0.6))
      material.triangleFillMode = .lines
      let entity = ModelEntity(mesh: mesh, materials: [material])
      anchor.addChild(entity)
      ghostEntity = entity
    } catch {
      // ceiling: decorative only — see the class-level note above.
      ghostEntity = nil
    }
  }

  // Crossfades the ghost out when the real GLB lands (plan section 1);
  // the wireframe box stays, since it is the measurement claim, not a
  // stand-in for the mesh.
  func hideGhost(animated: Bool) {
    guard let ghostEntity else { return }
    if animated {
      ghostEntity.move(
        to: Transform(scale: .zero, rotation: ghostEntity.orientation, translation: ghostEntity.position),
        relativeTo: ghostEntity.parent,
        duration: 0.4
      )
    } else {
      ghostEntity.removeFromParent()
    }
    self.ghostEntity = nil
  }
}
