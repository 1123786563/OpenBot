const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);

// Upstream watched the OpenMuse monorepo root so Metro could resolve
// `packages/domain` living outside this app. That package is vendored under
// ./packages/domain now (see MIGRATION.md), so watching this directory is enough
// — pointing at the OpenBot root would make Metro watch the whole backend repo.
config.watchFolders = [__dirname];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "jose" || moduleName.startsWith("jose/")) {
    return context.resolveRequest(
      { ...context, unstable_conditionNames: ["browser", "require", "import"] },
      moduleName,
      platform,
    );
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
