import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const ios = resolve(import.meta.dirname, "../ios");
const plist = resolve(ios, "OpenBot/Info.plist");

test("generated iOS app starts with one UIKit window scene", {
  skip: existsSync(plist) ? false : "run Expo iOS prebuild first",
}, () => {
  const manifestJSON = execFileSync(
    "plutil",
    ["-extract", "UIApplicationSceneManifest", "json", "-o", "-", plist],
    { encoding: "utf8" },
  );
  const manifest: unknown = JSON.parse(manifestJSON);
  assert.deepEqual(manifest, {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        {
          UISceneConfigurationName: "Default Configuration",
          UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
        },
      ],
    },
  });

  const appDelegate = readFileSync(
    resolve(ios, "OpenBot/AppDelegate.swift"),
    "utf8",
  );
  assert.equal(appDelegate.match(/startReactNative\(/g)?.length, 1);
  assert.doesNotMatch(appDelegate, /UIWindow\(frame:/);
  assert.match(appDelegate, /UIWindow\(windowScene:/);
  const project = readFileSync(
    resolve(ios, "OpenBot.xcodeproj/project.pbxproj"),
    "utf8",
  );
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.1;/);
});
