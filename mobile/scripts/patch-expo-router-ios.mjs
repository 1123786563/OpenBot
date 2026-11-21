import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Expo Router 55.0.18 declares iOS 15.1 but UIAction.subtitle requires iOS 16.
const require = createRequire(import.meta.url);
const sourcePath = join(
  dirname(require.resolve("expo-router/package.json")),
  "ios/LinkPreview/LinkPreviewNativeActionView.swift",
);
const original = "    if let subtitle = subtitle {\n      baseUiAction.subtitle = subtitle\n    }";
const guarded = "    if #available(iOS 16.0, *), let subtitle = subtitle {\n      baseUiAction.subtitle = subtitle\n    }";
const source = readFileSync(sourcePath, "utf8");

if (!source.includes(guarded)) {
  if (!source.includes(original)) {
    throw new Error("Expo Router changed its iOS link preview code. Recheck the UIAction.subtitle patch.");
  }
  writeFileSync(sourcePath, source.replace(original, guarded));
}
