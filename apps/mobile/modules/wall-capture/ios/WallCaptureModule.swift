import ExpoModulesCore

public final class WallCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WallCapture")

    Events("onQuad")

    OnCreate {
      DispatchQueue.main.async { [weak self] in
        WallCaptureController.shared.quadListeners.append { quad in
          self?.sendEvent("onQuad", ["found": quad != nil, "confidence": quad?.confidence ?? 0])
        }
      }
    }

    AsyncFunction("isSupported") { () -> Bool in WallCaptureController.isSupported }
    AsyncFunction("startSession") { () in WallCaptureController.shared.start() }
    AsyncFunction("stopSession") { () in WallCaptureController.shared.stop() }

    // `vertical` = a wall; false = floor or ceiling. Throws rather than
    // returning a face whose corners could not be placed in the world.
    AsyncFunction("capture") { (vertical: Bool) throws -> [String: Any] in
      let f = try WallCaptureController.shared.capture(vertical: vertical)
      return [
        "imagePath": f.imagePath,
        "cornersWorld": f.cornersWorld.map { [$0.x, $0.y, $0.z] },
        "widthMeters": f.widthMeters,
        "heightMeters": f.heightMeters,
        "center": ["x": f.center.x, "y": f.center.y, "z": f.center.z],
        "yawDeg": f.yawDeg,
        "detected": f.detected,
        "confidence": f.confidence,
      ]
    }.runOnQueue(.main)

    View(WallCaptureNativeView.self) {}
  }
}
