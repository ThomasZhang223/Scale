Pod::Spec.new do |s|
  s.name           = 'ObjectCapture'
  s.version        = '1.0.0'
  s.summary        = "Apple Object Capture: guided orbit, on-device photogrammetry, GLB export"
  s.description    = 'Hosts RealityKit ObjectCaptureSession/ObjectCaptureView, reconstructs with PhotogrammetrySession on-device, and exports the USDZ to a glTF binary for the headset. See apps/mobile/modules/object-capture/README.md.'
  s.author         = 'Full Scale'
  s.homepage       = 'https://github.com/fullscale/htn-2026'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
