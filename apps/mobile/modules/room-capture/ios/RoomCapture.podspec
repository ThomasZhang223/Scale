Pod::Spec.new do |s|
  s.name           = 'RoomCapture'
  s.version        = '1.0.0'
  s.summary        = 'RoomPlan capture on RoomCaptureSession, emitting RoomCapture v1 JSON'
  s.description    = 'Wraps RoomCaptureSession (never RoomCaptureView) with a gravityAndHeading-aligned ARSession. See apps/mobile/modules/room-capture/README.md.'
  s.author         = 'Full Scale'
  s.homepage       = 'https://github.com/fullscale/htn-2026'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
