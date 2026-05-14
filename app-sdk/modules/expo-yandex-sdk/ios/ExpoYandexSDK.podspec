require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json'))) rescue {}

Pod::Spec.new do |s|
  s.name           = 'ExpoYandexSDK'
  s.version        = '0.1.0'
  s.summary        = 'Yandex ID SDK wrapper for Expo'
  s.author         = ''
  s.homepage       = 'https://github.com/your/repo'
  s.platforms      = { :ios => '13.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # YandexLoginSDK distribution channel must be verified for the version you pin:
  #   - Some versions are on the public CocoaPods trunk
  #   - Some are only on Yandex's private podspec repo (check the official iOS SDK docs
  #     and add the corresponding `source '...'` line to the host app's Podfile if needed).
  # If `pod install` fails to resolve YandexLoginSDK, the source line is the first thing to fix.
  #
  # Pinned to 3.x: Yandex's current iOS SDK is 3.0.0, and the JWT-in-login-result API this
  # module relies on (`result.jwt`, Approach A) is documented from 2.1.0 onward — 3.x has it.
  # Still treat this as a to-confirm placeholder at first iOS build: verify API parity with
  # this module's Swift code (handleOpen, processUserActivity, authorize, the YXLoginResult
  # shape, and that `result.jwt` exists and is non-optional).
  s.dependency 'YandexLoginSDK', '~> 3.0'

  s.swift_version  = '5.4'
  s.source_files = "**/*.{h,m,swift}"
end
