import ExpoModulesCore
import RoomPlan

public final class RoomCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RoomCapture")

    Events("onInstruction", "onProgress")

    OnCreate {
      RoomCaptureController.shared.addInstructionListener { [weak self] instruction in
        self?.sendEvent("onInstruction", ["instruction": instruction])
      }
      RoomCaptureController.shared.addProgressListener { [weak self] progress in
        self?.sendEvent("onProgress", [
          "wallCount": progress.wallCount,
          "openingCount": progress.openingCount,
          "objectCount": progress.objectCount,
        ])
      }
    }

    AsyncFunction("isSupported") { () -> Bool in
      RoomCaptureController.shared.isSupported
    }

    AsyncFunction("startSession") { () in
      try RoomCaptureController.shared.start()
    }

    // Ends the sweep and returns RoomCapture v1 as a plain dictionary
    // (bridges to a JS object with no extra encode/decode step). Throws
    // rather than returning a partial room — never a synthesized fallback.
    AsyncFunction("stopSession") { () async throws -> [String: Any] in
      try await RoomCaptureController.shared.stopAndSerialize()
    }

    View(RoomCaptureNativeView.self) {}
  }
}
