import ExpoModulesCore
import YandexLoginSDK

// Forwards the OAuth callback URL (yx<clientId>://...) and universal-link continuation
// to YXLoginSDK so the native Yandex app SSO flow can complete.
//
// UNVERIFIED: exact YXLoginSDK API surface (handleOpen vs processUserActivity, parameter
// labels, throws vs Bool return) varies across SDK versions. Verify against the version
// pinned in the podspec at first iOS build and adjust if compile errors appear.
public class ExpoYandexSDKAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    do {
      try YXLoginSDK.handleOpen(url: url, sourceApplication: options[.sourceApplication] as? String)
      return true
    } catch {
      return false
    }
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    do {
      try YXLoginSDK.processUserActivity(userActivity)
      return true
    } catch {
      return false
    }
  }
}
