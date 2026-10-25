#!/usr/bin/env node
/*
 * check-better-auth-adapter-writes — the fixed-package scan gate for direct
 * `ctx.context.adapter` writes that bypass Better Auth's ALS store (T01.03 /
 * #515; interfaces §3.1).
 *
 * A directory write must reach the database through the request-local
 * transaction adapter the executor installs in the ALS store, so the fixed
 * packages' internal `getCurrentAdapter(...)` calls resolve to it. The 1.7.1
 * build still contains a closed, itemised set of uses of the raw
 * `ctx.context.adapter` expression (and of aliases bound to it); that set is
 * pinned in tests/config/better-auth-adapter-writes.json: package versions,
 * files, line numbers, methods and snippets.
 *
 * Scope — exactly what the manifest declares, no more. The scanned files are
 * the fixed composition this plan mounts (the core db/api/oauth2 layers, the
 * organization plugin, @better-auth/sso, @better-auth/scim, @better-auth/core).
 * Other plugin directories bundled inside better-auth (two-factor,
 * device-authorization, siwe, username, phone-number, …) are not mounted by
 * this composition and are out of scope by declaration: mounting a new plugin
 * is a scope change to the manifest, reviewed like any other.
 *
 * Two detection classes:
 *   - structural: a write-method use whose receiver is literally
 *     `ctx.context.adapter`, or an alias the manifest declares for that file
 *     as bound to the raw adapter (an assignment or parameter default). Every
 *     structural hit must be listed, and a package upgrade adding one fails.
 *   - anchored: a use through a helper parameter that the manifest pins by
 *     anchor — the call site that hands `ctx.context.adapter` to the function,
 *     plus the write line inside it. Anchored entries drift (moved lines or
 *     changed snippets) fail the same way; the unlisted-write gate does not
 *     discover new parameter-alias shapes, which is why each known one is
 *     pinned and disclosed.
 *
 * The scan is read-only. It reports, and exits non-zero, when an installed
 * package version differs from the pinned manifest version, when a pinned use
 * is gone or moved, or when the installed tree contains a structural direct
 * write the manifest does not list.
 *
 * Env overrides exist for the contract suite's injected-copy proof:
 *   BA_ADAPTER_WRITES_MANIFEST      manifest path
 *   BA_ADAPTER_WRITES_PACKAGE_ROOT  node_modules root to scan
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");

function posix(path) {
  return path.split(sep).join("/");
}

function resolvePackageDir(packageRoot, name) {
  for (const candidate of [
    join(packageRoot, name),
    join(repoRoot, "node_modules", name),
  ]) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

function collectMjsFiles(dir) {
  if (!existsSync(dir)) return [];
  const stat = statSync(dir);
  if (stat.isFile()) return dir.endsWith(".mjs") ? [dir] : [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    files.push(...collectMjsFiles(join(dir, entry)));
  }
  return files;
}

/**
 * Pure audit: returns {ok, problems, actual, versions} for a package root and
 * a parsed manifest. Never writes anything.
 */
export function auditBetterAuthAdapterWrites({ packageRoot, manifest }) {
  const problems = [];
  const actual = [];
  const versions = {};
  const writeMethods = new Set(manifest.writeMethods ?? []);
  const adapterMethods = new Set(manifest.adapterMethods ?? []);
  const aliases = manifest.aliases ?? {};
  const packageDirs = {};

  for (const [packageName, expectedVersion] of Object.entries(
    manifest.packages ?? {},
  )) {
    const packageDir = resolvePackageDir(packageRoot, packageName);
    if (!packageDir) {
      problems.push(
        `package ${packageName} is not installed under ${packageRoot}`,
      );
      continue;
    }
    packageDirs[packageName] = packageDir;
    const installed = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );
    versions[packageName] = installed.version;
    if (installed.version !== expectedVersion) {
      problems.push(
        `package ${packageName} is installed at ${installed.version}, manifest pins ${expectedVersion} — re-review and re-pin before upgrading`,
      );
    }

    const scope = manifest.scope?.[packageName] ?? [];
    const files = new Set();
    for (const entry of scope) {
      for (const file of collectMjsFiles(join(packageDir, entry))) {
        files.add(file);
      }
    }

    for (const file of [...files].sort()) {
      const relativeFile = posix(file.slice(packageDir.length + 1));
      const fileAliases = Object.keys(
        aliases[`${packageName}:${relativeFile}`] ?? {},
      );
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(
          /ctx\.context\.adapter\.([A-Za-z]+)/g,
        )) {
          if (!writeMethods.has(match[1])) continue;
          actual.push({
            package: packageName,
            file: relativeFile,
            line: index + 1,
            method: match[1],
            snippet: line.trim(),
          });
        }
        for (const alias of fileAliases) {
          // An alias resolves to the raw base adapter only where the call is
          // not itself routed through getCurrentAdapter.
          if (line.includes("getCurrentAdapter")) continue;
          const match = new RegExp(`(?<![\\w$.])${alias}\\.([A-Za-z]+)`).exec(
            line,
          );
          if (!match || !adapterMethods.has(match[1])) continue;
          actual.push({
            package: packageName,
            file: relativeFile,
            line: index + 1,
            method: match[1],
            snippet: line.trim(),
          });
        }
      });
    }
  }

  const key = (entry) =>
    `${entry.package}:${entry.file}:${entry.line}:${entry.method}`;
  const expectedByKey = new Map(
    (manifest.writes ?? []).map((entry) => [key(entry), entry]),
  );
  const actualByKey = new Map(actual.map((entry) => [key(entry), entry]));

  const lineAt = (packageName, file, line) => {
    const packageDir = packageDirs[packageName];
    if (!packageDir) return undefined;
    return readFileSync(join(packageDir, file), "utf8").split("\n")[line - 1];
  };

  for (const [writeKey, entry] of expectedByKey) {
    if (entry.anchor) {
      // Parameter-aliased use: pin the call site that passes the raw adapter
      // and the write line inside the callee. Both must still read as pinned.
      const anchorLine = lineAt(
        entry.package,
        entry.anchor.file,
        entry.anchor.line,
      );
      const writeLine = lineAt(entry.package, entry.file, entry.line);
      if (
        !anchorLine?.includes(entry.anchor.snippet) ||
        !writeLine?.includes(entry.snippet)
      ) {
        problems.push(
          `anchored direct write drifted: ${writeKey} (anchor ${entry.anchor.file}:${entry.anchor.line} must contain "${entry.anchor.snippet}") — re-review the parameter pass-through`,
        );
      }
      continue;
    }
    const found = actualByKey.get(writeKey);
    if (!found) {
      problems.push(
        `pinned direct write is missing: ${writeKey} (${entry.snippet ?? "no snippet"}) — refuse to treat a moved/removed write as covered`,
      );
      continue;
    }
    if (entry.snippet && !found.snippet.includes(entry.snippet)) {
      problems.push(
        `pinned direct write snippet drifted: ${writeKey} now reads "${found.snippet}", manifest pins "${entry.snippet}"`,
      );
    }
  }
  for (const writeKey of actualByKey.keys()) {
    if (!expectedByKey.has(writeKey)) {
      problems.push(
        `unlisted direct adapter write: ${writeKey} — a write that bypasses the ALS store must be classified in the manifest before it may ship`,
      );
    }
  }

  return { ok: problems.length === 0, problems, actual, versions };
}

function main() {
  const manifestPath =
    process.env.BA_ADAPTER_WRITES_MANIFEST ??
    join(repoRoot, "tests/config/better-auth-adapter-writes.json");
  const packageRoot =
    process.env.BA_ADAPTER_WRITES_PACKAGE_ROOT ??
    join(repoRoot, "server/node_modules");

  if (!existsSync(manifestPath)) {
    console.error(`::error::missing adapter-write manifest: ${manifestPath}`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const { ok, problems, actual, versions } = auditBetterAuthAdapterWrites({
    packageRoot,
    manifest,
  });

  const versionSummary = Object.entries(versions)
    .map(([name, version]) => `${name}@${version}`)
    .join(", ");
  if (!ok) {
    console.error(
      `better-auth adapter write scan: ${problems.length} problem(s) against ${packageRoot} (${versionSummary || "no package resolved"})`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `better-auth adapter write scan: ok — ${actual.length} structural direct write(s) match the manifest, anchored entries verified (${versionSummary})`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exit(main());
}
