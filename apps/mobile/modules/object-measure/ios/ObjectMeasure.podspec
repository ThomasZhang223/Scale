Pod::Spec.new do |s|
  s.name           = 'ObjectMeasure'
  s.version        = '1.0.0'
  s.summary        = 'LiDAR raycast-and-grow object measurement, no machine learning'
  s.description    = 'Measures a single object alone on a table via ARKit sceneDepth, plus the sweep frame capture for the generator. See apps/mobile/modules/object-measure/README.md.'
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
