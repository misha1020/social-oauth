import ExpoModulesCore
import YandexLoginSDK

public class ExpoYandexSDKModule: Module {
  private var pendingPromise: Promise?

  public func definition() -> ModuleDefinition {
    Name("ExpoYandexSDK")

    OnCreate {
      guard let clientId = Bundle.main.object(forInfoDictionaryKey: "YandexClientID") as? String else {
        return
      }
      try? YXLoginSDK.activate(withAppId: clientId)
      YXLoginSDK.add(observer: self)
    }

    AsyncFunction("authorize") { (promise: Promise) in
      if self.pendingPromise != nil {
        promise.reject("YANDEX_AUTH_ERROR", "Authorization already in progress")
        return
      }
      self.pendingPromise = promise

      DispatchQueue.main.async {
        guard let rootVC = Self.topRootViewController() else {
          self.pendingPromise = nil
          promise.reject("YANDEX_AUTH_ERROR", "No root view controller")
          return
        }
        do {
          try YXLoginSDK.authorize(with: rootVC)
        } catch {
          self.pendingPromise = nil
          promise.reject("YANDEX_AUTH_ERROR", error.localizedDescription)
        }
      }
    }
  }

  private static func topRootViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
    let keyWindow = activeScene?.windows.first(where: { $0.isKeyWindow }) ?? activeScene?.windows.first
    return keyWindow?.rootViewController
  }
}

extension ExpoYandexSDKModule: YXLoginSDKObserver {
  public func didFinishLogin(with result: Result<YXLoginResult, Error>) {
    guard let promise = pendingPromise else { return }
    pendingPromise = nil
    switch result {
    case .success(let r):
      promise.resolve([
        "accessToken": r.token,
        "expiresIn": r.expiresIn ?? 0
      ])
    case .failure(let err):
      let nsErr = err as NSError
      // -2 cancellation code is a placeholder; verify against YandexLoginSDK headers when iOS testing happens.
      if nsErr.domain == "YXLoginSDKErrorDomain" && nsErr.code == -2 {
        promise.resolve(["cancelled": true])
      } else {
        promise.reject("YANDEX_AUTH_ERROR", err.localizedDescription)
      }
    }
  }
}
