import ExpoModulesCore
import RealityKit
import SwiftUI

// Hosts Apple's SwiftUI ObjectCaptureView (camera feed, the detection box,
// the capture dial) inside an Expo view. The session comes from the shared
// controller: whichever mounts first — this view or startSession() — the
// SwiftUI view attaches as soon as both exist.
class ObjectCaptureNativeView: ExpoView {
  private var host: UIHostingController<AnyView>?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    Task { @MainActor [weak self] in
      guard let self else { return }
      let controller = ObjectCaptureController.shared
      controller.sessionListeners.append { [weak self] session in
        self?.attach(session)
      }
      self.attach(controller.session)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host?.view.frame = bounds
  }

  @MainActor
  private func attach(_ session: ObjectCaptureSession?) {
    host?.view.removeFromSuperview()
    host = nil
    guard let session else { return }
    let hosting = UIHostingController(rootView: AnyView(
      ObjectCaptureView(session: session).ignoresSafeArea()
    ))
    hosting.view.backgroundColor = .clear
    hosting.view.frame = bounds
    addSubview(hosting.view)
    host = hosting
  }
}
