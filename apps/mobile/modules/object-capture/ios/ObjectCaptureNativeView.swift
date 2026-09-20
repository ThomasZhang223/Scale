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

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Parent the hosting controller once we are in a window; SwiftUI camera
    // views need a real view-controller hierarchy for their lifecycle.
    if window != nil, let host, host.parent == nil { parentController(host) }
  }

  private func parentController(_ hosting: UIHostingController<AnyView>) {
    var responder: UIResponder? = next
    while let r = responder, !(r is UIViewController) { responder = r.next }
    guard let parent = responder as? UIViewController else { return }
    parent.addChild(hosting)
    hosting.didMove(toParent: parent)
    NSLog("[ObjectCapture] view hosted under %@", String(describing: type(of: parent)))
  }

  @MainActor
  private func attach(_ session: ObjectCaptureSession?) {
    if let host {
      host.willMove(toParent: nil)
      host.view.removeFromSuperview()
      host.removeFromParent()
    }
    host = nil
    guard let session else { return }
    NSLog("[ObjectCapture] attaching ObjectCaptureView, bounds=%@", NSCoder.string(for: bounds))
    let hosting = UIHostingController(rootView: AnyView(
      ObjectCaptureView(session: session).ignoresSafeArea()
    ))
    hosting.view.backgroundColor = .clear
    hosting.view.frame = bounds
    addSubview(hosting.view)
    host = hosting
    if window != nil { parentController(hosting) }
  }
}
