import ExpoModulesCore
import RealityKit
import UIKit

// The progress overlay we draw ourselves, since we do not use Apple's
// RoomCaptureView (see the module README and plan section 2). RealityKit's
// ARView here is a camera-passthrough renderer only — it shares the same
// ARSession that RoomCaptureController hands to RoomCaptureSession, it does
// not run its own.
class RoomCaptureNativeView: ExpoView {
  private let arView = ARView(frame: .zero)
  private let instructionLabel = UILabel()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    arView.session = RoomCaptureController.shared.arSession
    arView.automaticallyConfigureSession = false
    addSubview(arView)

    instructionLabel.textColor = .white
    instructionLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    instructionLabel.textAlignment = .center
    instructionLabel.font = .preferredFont(forTextStyle: .headline)
    instructionLabel.layer.cornerRadius = 12
    instructionLabel.layer.masksToBounds = true
    instructionLabel.text = "  Move slowly around the room  "
    addSubview(instructionLabel)

    RoomCaptureController.shared.addInstructionListener { [weak self] instruction in
      DispatchQueue.main.async {
        self?.instructionLabel.text = "  \(Self.displayText(for: instruction))  "
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    arView.frame = bounds
    let labelHeight: CGFloat = 44
    instructionLabel.frame = CGRect(
      x: 16,
      y: bounds.height - labelHeight - 32,
      width: bounds.width - 32,
      height: labelHeight
    )
  }

  private static func displayText(for instruction: String) -> String {
    switch instruction {
    case "moveCloseToWall": return "Move closer to the wall"
    case "moveAwayFromWall": return "Move away from the wall"
    case "turnOnLight": return "Turn on more light"
    case "slowDown": return "Slow down"
    case "lowTexture": return "Point at a more detailed surface"
    default: return "Move slowly around the room"
    }
  }
}
