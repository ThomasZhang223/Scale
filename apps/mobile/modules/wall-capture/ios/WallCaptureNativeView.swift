import ARKit
import ExpoModulesCore
import RealityKit
import UIKit

// Camera passthrough plus the live outline of the rectangle Vision sees.
// Corners are in the raw landscape buffer; the view shows that buffer
// rotated to portrait and aspect-filled, so each corner goes through the
// same mapping: rotate, then scale to the view.
class WallCaptureNativeView: ExpoView {
  private let arView = ARView(frame: .zero)
  private let outline = CAShapeLayer()
  private let dots = CAShapeLayer()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    arView.session = WallCaptureController.shared.arSession
    arView.automaticallyConfigureSession = false
    addSubview(arView)
    outline.fillColor = UIColor.systemGreen.withAlphaComponent(0.12).cgColor
    outline.strokeColor = UIColor.systemGreen.cgColor
    outline.lineWidth = 3
    outline.lineJoin = .round
    dots.fillColor = UIColor.white.cgColor
    layer.addSublayer(outline)
    layer.addSublayer(dots)
    WallCaptureController.shared.quadListeners.append { [weak self] quad in self?.draw(quad) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    arView.frame = bounds
    outline.frame = bounds
    dots.frame = bounds
  }

  private func draw(_ quad: DetectedQuad?) {
    guard let quad, bounds.width > 0 else {
      outline.path = nil
      dots.path = nil
      return
    }
    // ARKit's own map from raw-buffer image coordinates (top-left origin) to this portrait,
    // aspect-filled view — rotation and crop included. Vision's bottom-left origin folded in.
    guard let frame = WallCaptureController.shared.arSession.currentFrame else { return }
    let t = frame.displayTransform(for: .portrait, viewportSize: bounds.size)
    let pts = quad.corners.map { c -> CGPoint in
      let v = CGPoint(x: c.x, y: 1 - c.y).applying(t)
      return CGPoint(x: v.x * bounds.width, y: v.y * bounds.height)
    }
    let path = UIBezierPath()
    path.move(to: pts[0]); for p in pts.dropFirst() { path.addLine(to: p) }
    path.close()
    outline.path = path.cgPath
    let d = UIBezierPath()
    for p in pts { d.append(UIBezierPath(ovalIn: CGRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10))) }
    dots.path = d.cgPath
  }
}
