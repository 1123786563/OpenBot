const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { withPodfile } = require("expo/config-plugins");

const postInstall = "  post_install do |installer|";
const raiseBundleTarget = `    # Use the app's iOS floor for SDWebImage's legacy resource bundle.
    minimum = podfile_properties['ios.deploymentTarget'] || '15.1'
    installer.pods_project.targets.each do |target|
      next unless target.name == 'SDWebImage-SDWebImage'

      target.build_configurations.each do |configuration|
        configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum
      end
    end`;

module.exports = function withIosReleaseCompatibility(config) {
  return withPodfile(config, (config) => {
    const router = dirname(require.resolve("expo-router/package.json"));
    const actionView = join(
      router,
      "ios",
      "LinkPreview",
      "LinkPreviewNativeActionView.swift",
    );
    const source = readFileSync(actionView, "utf8");
    // Expo Router 55 uses an iOS 16 API while supporting iOS 15.1.
    const guarded = source.replace(
      "if let subtitle = subtitle {\n      baseUiAction.subtitle = subtitle",
      "if #available(iOS 16.0, *), let subtitle = subtitle {\n      baseUiAction.subtitle = subtitle",
    );
    if (guarded !== source) writeFileSync(actionView, guarded);

    const podfile = config.modResults;
    if (!podfile.contents.includes(raiseBundleTarget)) {
      if (!podfile.contents.includes(postInstall)) {
        throw new Error("Expo's Podfile is missing its post_install hook.");
      }
      podfile.contents = podfile.contents.replace(
        postInstall,
        `${postInstall}\n${raiseBundleTarget}\n`,
      );
    }
    return config;
  });
};
