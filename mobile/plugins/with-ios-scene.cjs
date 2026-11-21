const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const sceneManifest = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [{
      UISceneConfigurationName: "Default Configuration",
      UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
    }],
  },
};

const legacyStartup = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

`;

module.exports = function withIOSScene(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = sceneManifest;
    return config;
  });

  return withAppDelegate(config, (config) => {
    const appDelegate = config.modResults;
    const sceneDelegate = readFileSync(join(__dirname, "SceneDelegate.swift"), "utf8");
    if (appDelegate.contents.endsWith(sceneDelegate)) {
      return config;
    }

    if (appDelegate.language !== "swift" || !appDelegate.contents.includes(legacyStartup)) {
      throw new Error("with-ios-scene expects the Expo SDK 55 Swift AppDelegate template. Review scene support before upgrading Expo.");
    }

    // Keep the delegate in AppDelegate.swift so prebuild reuses the existing target membership.
    appDelegate.contents = appDelegate.contents.replace(legacyStartup, "").trimEnd() +
      "\n\n" + sceneDelegate;
    return config;
  });
};
