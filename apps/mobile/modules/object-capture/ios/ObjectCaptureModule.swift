import ExpoModulesCore
import RealityKit
import SwiftUI

public final class ObjectCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ObjectCapture")

    Events("onState", "onFeedback", "onShots", "onReconstructionProgress")

    OnCreate {
      Task { @MainActor [weak self] in
        let c = ObjectCaptureController.shared
        c.stateListeners.append { state in self?.sendEvent("onState", ["state": state]) }
        c.feedbackListeners.append { feedback in self?.sendEvent("onFeedback", ["feedback": feedback]) }
        c.shotsListeners.append { taken, max in self?.sendEvent("onShots", ["taken": taken, "max": max]) }
        c.progressListeners.append { fraction, phase in
          self?.sendEvent("onReconstructionProgress", ["fraction": fraction, "phase": phase])
        }
      }
    }

    AsyncFunction("isSupported") { () async -> Bool in
      await MainActor.run { ObjectCaptureController.isSupported }
    }

    AsyncFunction("startSession") { () async throws in
      try await ObjectCaptureController.shared.start()
    }

    AsyncFunction("startDetecting") { () async throws in
      try await ObjectCaptureController.shared.startDetecting()
    }

    AsyncFunction("startCapturing") { () async throws in
      try await ObjectCaptureController.shared.startCapturing()
    }

    // Resolves when every image is on disk and reconstruction may begin.
    AsyncFunction("finishCapture") { () async throws in
      try await ObjectCaptureController.shared.finish()
    }

    AsyncFunction("cancelSession") { () async in
      await ObjectCaptureController.shared.cancel()
    }

    // Minutes, not seconds. Progress arrives on onReconstructionProgress.
    // Throws rather than returning a partial model.
    AsyncFunction("reconstruct") { (detail: String) async throws -> [String: Any] in
      let r = try await ObjectCaptureController.shared.reconstruct(detail: detail)
      return [
        "usdzPath": r.usdzPath,
        "glbPath": r.glbPath,
        "bboxMeters": ["w": r.bboxMeters.x, "h": r.bboxMeters.y, "d": r.bboxMeters.z],
        "imageCount": r.imageCount,
      ]
    }

    View(ObjectCaptureNativeView.self) {}
  }
}
