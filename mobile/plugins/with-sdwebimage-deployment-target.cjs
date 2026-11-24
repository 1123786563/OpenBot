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

module.exports = function withSDWebImageDeploymentTarget(config) {
  return withPodfile(config, (config) => {
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
