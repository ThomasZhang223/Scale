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
    // Raw buffer is landscape-right. In view space (portrait): x_view = 1 - y_raw, y_view = 1 - x_raw
    // with Vision's bottom-left origin folded in. Then aspect-fill: the buffer's 4:3 becomes the
    // view's 3:4 rotated, so the mapping is uniform in both axes once rotated.
    let pts = quad.corners.map { c -> CGPoint in
      CGPoint(x: c.y * bounds.width, y: c.x * bounds.height)
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
