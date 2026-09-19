import ExpoModulesCore
import RealityKit
import simd

// Camera passthrough plus two overlays: the measured-box wireframe (plan
// section 5, "the visible claim that the size is real"), and the point-cloud
// ghost while the mesh generates (plan section 1). Shares
// ObjectMeasureController's ARSession; does not run its own.
class ObjectMeasureNativeView: ExpoView {
  private let arView = ARView(frame: .zero)
  private var boxEntity: ModelEntity?
  private var ghostGroup: Entity?
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

  // ceiling: UnlitMaterial.triangleFillMode (the line-drawing needed for an
  // actual wireframe) is iOS 18+ — found by an actual compile, not by
  // inspection. Below 18 we draw nothing at all rather than a solid box:
  // a near-opaque fill at this alpha would hide the very object being
  // measured, which is worse than showing no box. The measured numbers
  // still return and display regardless — only this outline is missing.
  // Not worth raising the deployment target for (unlike RoomCaptureSession
  // in modules/room-capture, which had no working fallback at all): a LiDAR
  // device can plausibly sit on 17.x, and every LiDAR iPhone (12 Pro
  // onward) is expected to comfortably run 18 regardless, so this path may
  // never execute on the real demo device.
  func showWireframeBox(
    center: SIMD3<Float>,
    widthMeters: Float,
    heightMeters: Float,
    depthMeters: Float,
    yawDeg: Float
  ) {
    boxEntity?.removeFromParent()
    guard #available(iOS 18.0, *) else {
      boxEntity = nil
      return
    }

    let mesh = MeshResource.generateBox(width: widthMeters, height: heightMeters, depth: depthMeters)
    var material = UnlitMaterial(color: .white.withAlphaComponent(0.9))
    material.triangleFillMode = .lines
    let entity = ModelEntity(mesh: mesh, materials: [material])
    entity.position = center
    entity.orientation = simd_quatf(angle: yawDeg * .pi / 180, axis: [0, 1, 0])
    anchor.addChild(entity)
    boxEntity = entity
  }

  // ceiling: RealityKit's MeshDescriptor has no point-primitive case at all
  // (confirmed against Apple's docs — only .triangles, .trianglesAndQuads,
  // .polygons exist), so this cannot be one mesh the way the wireframe box
  // is. Each surviving sample becomes its own tiny solid sphere instead
  // (no triangleFillMode needed — a solid dot is the correct look for a
  // point, not a wireframe outline, so this needs no iOS-18 guard either),
  // capped at 200 with even subsampling above that. A real per-entity cost,
  // acceptable because it only lives for the few seconds the mesh is
  // generating. Upgrade path if this ever needs to scale further: a custom
  // LowLevelMesh with an explicit point primitive type.
  func showGhost(points: [SIMD3<Float>]) {
    ghostGroup?.removeFromParent()
    guard !points.isEmpty else { return }

    let cap = 200
    let sampled: [SIMD3<Float>]
    if points.count > cap {
      let stride = Double(points.count) / Double(cap)
      sampled = (0..<cap).map { points[Int(Double($0) * stride)] }
    } else {
      sampled = points
    }

    let group = Entity()
    let mesh = MeshResource.generateSphere(radius: 0.004) // 4 mm — reads as a point, not a blob
    let material = UnlitMaterial(color: .cyan.withAlphaComponent(0.6))
    for point in sampled {
      let sphere = ModelEntity(mesh: mesh, materials: [material])
      sphere.position = point
      group.addChild(sphere)
    }
    anchor.addChild(group)
    ghostGroup = group
  }

  // Crossfades the ghost out when the real GLB lands (plan section 1);
  // the wireframe box stays, since it is the measurement claim, not a
  // stand-in for the mesh.
  func hideGhost(animated: Bool) {
    guard let ghostGroup else { return }
    if animated {
      ghostGroup.move(
        to: Transform(scale: .zero, rotation: ghostGroup.orientation, translation: ghostGroup.position),
        relativeTo: ghostGroup.parent,
        duration: 0.4
      )
    } else {
      ghostGroup.removeFromParent()
    }
    self.ghostGroup = nil
  }
}
