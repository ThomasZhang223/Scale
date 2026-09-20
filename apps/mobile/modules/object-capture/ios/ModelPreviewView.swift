import ExpoModulesCore
import SceneKit

// The captured object itself, rendered by SceneKit from the USDZ the phone
// built: textures, lighting and a finger-drag orbit for free. SceneKit reads
// USDZ natively; nothing in three.js is needed, and nothing here runs in a
// browser-shaped runtime (the expo-gl + three path needs `document`).
class ModelPreviewView: ExpoView {
  private let sceneView = SCNView(frame: .zero)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    sceneView.backgroundColor = .clear
    sceneView.allowsCameraControl = true
    sceneView.autoenablesDefaultLighting = true
    sceneView.antialiasingMode = .multisampling4X
    sceneView.defaultCameraController.interactionMode = .orbitTurntable
    addSubview(sceneView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.frame = bounds
  }

  func load(url: URL?) {
    guard let url else {
      sceneView.scene = nil
      return
    }
    do {
      let scene = try SCNScene(url: url, options: [.checkConsistency: false])
      scene.background.contents = UIColor.clear
      sceneView.scene = scene
      // Frame the object: SceneKit's default camera controller frames the
      // whole scene bounding sphere when there is no camera node in it.
      sceneView.pointOfView = nil
      sceneView.defaultCameraController.frameNodes(scene.rootNode.childNodes)
      // A slow turntable so a still page reads as 3D. Drag interrupts it.
      let spin = CABasicAnimation(keyPath: "rotation")
      spin.fromValue = NSValue(scnVector4: SCNVector4(0, 1, 0, 0))
      spin.toValue = NSValue(scnVector4: SCNVector4(0, 1, 0, Float.pi * 2))
      spin.duration = 14
      spin.repeatCount = .infinity
      scene.rootNode.addAnimation(spin, forKey: "turntable")
    } catch {
      NSLog("[ModelPreview] failed to load %@: %@", url.path, error.localizedDescription)
      sceneView.scene = nil
    }
  }
}
