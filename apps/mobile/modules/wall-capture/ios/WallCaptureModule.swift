import ExpoModulesCore

public final class WallCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WallCapture")

    Events("onQuad")

    OnCreate { [weak self] in
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

    // Library photos: Apple's picker, then the same straightening without ARKit.
    AsyncFunction("pickPhoto") { () async throws -> String? in
      try await PhotoPicker.pick()
    }

    AsyncFunction("rectifyPhoto") { (path: String) throws -> [String: Any] in
      guard let r = WallRectifier.rectifyLibraryPhoto(path: path) else {
        throw NSError(domain: "WallCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not read or straighten that photo"])
      }
      return ["imagePath": r.imagePath, "aspect": r.aspect, "aspectIsMetric": r.aspectIsMetric, "detected": r.detected, "confidence": r.confidence]
    }

    View(WallCaptureNativeView.self) {}
  }
}
