final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    // React Native reads cold links from launch options. The forwarding below
    // also gives Expo Linking and the Expo dev client their usual callbacks.
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = options.urlContexts.first?.url {
      launchOptions[.url] = url
    } else if let activity = options.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) {
      launchOptions[.userActivityDictionary] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ]
    }

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions.isEmpty ? nil : launchOptions
    )

    self.scene(scene, openURLContexts: options.urlContexts)
    for activity in options.userActivities {
      self.scene(scene, continue: activity)
    }

    // Expo's UNUserNotificationCenterDelegate receives notification responses
    // directly, including at launch. Replaying them here could deliver them twice.
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    let application = UIApplication.shared
    guard let delegate = application.delegate as? AppDelegate else { return }
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace,
      ]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = delegate.application(application, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    let application = UIApplication.shared
    guard let delegate = application.delegate as? AppDelegate else { return }
    _ = delegate.application(application, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    let application = UIApplication.shared
    (application.delegate as? AppDelegate)?.applicationWillEnterForeground(application)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    let application = UIApplication.shared
    (application.delegate as? AppDelegate)?.applicationDidBecomeActive(application)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    let application = UIApplication.shared
    (application.delegate as? AppDelegate)?.applicationWillResignActive(application)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    let application = UIApplication.shared
    (application.delegate as? AppDelegate)?.applicationDidEnterBackground(application)
  }
}
