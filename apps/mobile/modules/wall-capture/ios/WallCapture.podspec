Pod::Spec.new do |s|
  s.name           = 'WallCapture'
  s.version        = '1.0.0'
  s.summary        = 'Six-face room capture: rectangle detection, four-point rectification, ARKit-measured wall pose'
  s.description    = 'The RoomPlan fallback. One photo per face of a box-shaped room; Vision finds the wall quadrilateral, Core Image rectifies it, ARKit raycasts the four corners for metres. See apps/mobile/modules/wall-capture/README.md.'
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
