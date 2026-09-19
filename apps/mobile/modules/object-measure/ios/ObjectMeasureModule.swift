import ExpoModulesCore
import CoreGraphics

struct MeasureTapPoint: Record {
  @Field var x: Double = 0.5
  @Field var y: Double = 0.5
}

struct WireframeBoxProp: Record {
  @Field var centerX: Double = 0
  @Field var centerY: Double = 0
  @Field var centerZ: Double = 0
  @Field var widthMeters: Double = 0
  @Field var heightMeters: Double = 0
  @Field var depthMeters: Double = 0
  @Field var yawDeg: Double = 0
}

public final class ObjectMeasureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ObjectMeasure")

    AsyncFunction("isSupported") { () -> Bool in
      ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    AsyncFunction("startSession") { () in
      ObjectMeasureController.shared.start()
    }

    AsyncFunction("stopSession") { () in
      ObjectMeasureController.shared.stop()
    }

    // `tap` is a normalized UI coordinate — 0,0 top-left, 1,1 bottom-right —
    // matching ARFrame.raycastQuery(from:). Throws rather than returning a
    // partial or zero measurement on any failure (no plane found, tracking
    // lost, too few surviving samples): see ObjectMeasureError.
    AsyncFunction("measure") { (tap: MeasureTapPoint) async throws -> [String: Any] in
      let result = try await ObjectMeasureController.shared.measure(
        normalizedTapPoint: CGPoint(x: tap.x, y: tap.y)
      )
      return [
        "bboxMeters": [
          "w": result.widthMeters,
          "h": result.heightMeters,
          "d": result.depthMeters,
        ],
        "center": ["x": result.centerWorld.x, "y": result.centerWorld.y, "z": result.centerWorld.z],
        "yawDeg": result.yawDeg,
        "confidence": result.confidence,
        "framePaths": result.framePaths,
        "ambientIntensityLux": result.ambientIntensityLux as Any,
        "ambientColorTemperatureK": result.ambientColorTemperatureK as Any,
        "ghostPoints": result.ghostPoints.map { [$0.x, $0.y, $0.z] },
      ]
    }

    View(ObjectMeasureNativeView.self) {
      Prop("wireframeBox") { (view: ObjectMeasureNativeView, box: WireframeBoxProp?) in
        guard let box else { return }
        view.showWireframeBox(
          center: SIMD3(Float(box.centerX), Float(box.centerY), Float(box.centerZ)),
          widthMeters: Float(box.widthMeters),
          heightMeters: Float(box.heightMeters),
          depthMeters: Float(box.depthMeters),
          yawDeg: Float(box.yawDeg)
        )
      }

      Prop("ghostPoints") { (view: ObjectMeasureNativeView, points: [[Double]]?) in
        guard let points else { return }
        view.showGhost(points: points.compactMap { p in
          guard p.count == 3 else { return nil }
          return SIMD3(Float(p[0]), Float(p[1]), Float(p[2]))
        })
      }

      Prop("ghostVisible") { (view: ObjectMeasureNativeView, visible: Bool?) in
        if visible == false {
          view.hideGhost(animated: true)
        }
      }
    }
  }
}
