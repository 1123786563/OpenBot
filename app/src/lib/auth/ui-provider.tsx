import type { PropsWithChildren, ReactElement } from "react";
import { OpenBotAuthUIProvider } from "@/components/auth/provider";
import uiSourceJson from "./ui-source.json";

/** The committed manifest; the JSON module's inferred strings are narrowed by this type and checked at runtime by verifyUiSource. */
const uiSource = uiSourceJson as unknown as UiSourceManifest;

/*
 * OpenBotAuthProvider and the manifest contract of the fixed Better Auth UI
 * source (T01.08, #520).
 *
 * The Better Auth UI kit is vendored from exactly one pinned source recorded in
 * app/src/lib/auth/ui-source.json: URL, tarball digest, license, per-file
 * hashes, and — for every organization component the source exports — a
 * declaration of whether OpenBot injects its own adapter or does not reuse the
 * component at all. verifyUiSource is the structural half of that contract (the
 * byte-level half runs as a command from the test, where the files and the
 * lockfile can be read); an unpinned or incompatible manifest must make the
 * provider refuse to mount rather than render from an unverified source.
 */

/** One vendored registry file: where it lives here, where it came from, its bytes. */
export type UiSourceVendoredEntry = {
  path: string;
  upstream: string;
  sha256: string;
  note?: string;
};

export type UiSourceOrganizationDeclarations = Record<
  string,
  {
    reuse: "inject-openbot-adapter" | "not-reused";
    upstream: string;
    xClassDependencies?: string[];
    note?: string;
  }
>;

/** The shape ui-source.json must keep for the provider to mount. */
export type UiSourceManifest = {
  manifestVersion: number;
  task: string;
  source: {
    name: string;
    package: string;
    version: string;
    url: string;
    digest: string;
    license: string;
    licenseSource: string;
    compatibility: { "better-auth": string; peerRange: string };
    compatibilityNote?: string;
  };
  registryRoot: string;
  organizationRegistryDir: string;
  xClassEndpoints: string[];
  vendored: UiSourceVendoredEntry[];
  organization: UiSourceOrganizationDeclarations;
  /** sha256 of the pinned-source files the vendored closure adapts, from the verified tarball. */
  upstreamHashes?: Record<string, string>;
};

export type UiSourceVerdict = { ok: boolean; errors: string[] };

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REUSE_VALUES = ["inject-openbot-adapter", "not-reused"] as const;
/** The version the server pins; the UI source must be recorded against it. */
const SERVER_BETTER_AUTH_PIN = "1.7.1";

/**
 * Structural validation of a ui-source manifest. Pure data in, verdict out, so
 * the browser-side provider and the command-side byte check share one contract.
 * Anything unpinned (version range, missing digest), off the fixed registry
 * root, or missing a declaration is rejected.
 */
export function verifyUiSource(manifest: unknown): UiSourceVerdict {
  const errors: string[] = [];
  const fail = (error: string) => errors.push(error);

  const m = manifest as Partial<UiSourceManifest> | null;
  if (!m || typeof m !== "object") {
    return { ok: false, errors: ["ui-source manifest: not an object"] };
  }

  if (m.manifestVersion !== 1) fail("manifestVersion: expected 1");

  const source = m.source;
  if (!source || typeof source !== "object") {
    fail("source: missing");
  } else {
    if (!source.name) fail("source.name: missing");
    if (
      typeof source.version !== "string" ||
      !EXACT_VERSION.test(source.version)
    ) {
      fail(
        `source.version: must be an exact x.y.z pin, got ${JSON.stringify(source.version)}`,
      );
    }
    if (typeof source.url !== "string" || !source.url.startsWith("https://")) {
      fail("source.url: must be an https URL");
    }
    if (
      typeof source.digest !== "string" ||
      !SHA512_INTEGRITY.test(source.digest)
    ) {
      fail("source.digest: must be an npm sha512 integrity string");
    }
    if (!source.license) fail("source.license: missing");
    if (
      !source.compatibility ||
      source.compatibility["better-auth"] !== SERVER_BETTER_AUTH_PIN
    ) {
      fail(
        `source.compatibility.better-auth: must record the server pin ${SERVER_BETTER_AUTH_PIN}`,
      );
    }
  }

  if (m.registryRoot !== "app/src/components/auth") {
    fail("registryRoot: the registry is fixed at app/src/components/auth");
  }
  if (m.organizationRegistryDir !== "app/src/components/auth/organization") {
    fail(
      "organizationRegistryDir: organization components are fixed at app/src/components/auth/organization",
    );
  }

  if (
    !Array.isArray(m.xClassEndpoints) ||
    m.xClassEndpoints.length === 0 ||
    !m.xClassEndpoints.every(
      (path) => typeof path === "string" && path.startsWith("/organization/"),
    )
  ) {
    fail("xClassEndpoints: must list the organization X-class GET paths");
  }

  if (!Array.isArray(m.vendored) || m.vendored.length === 0) {
    fail("vendored: the Provider/Auth entry closure must be vendored");
  } else {
    const registryRootPrefix = `${m.registryRoot ?? ""}/`;
    const seenPaths = new Set<string>();
    for (const entry of m.vendored) {
      if (
        !entry?.path?.startsWith(registryRootPrefix) ||
        entry.path.includes("..")
      ) {
        fail(
          `vendored path: ${entry?.path} must live under ${registryRootPrefix}`,
        );
        continue;
      }
      if (seenPaths.has(entry.path)) {
        fail(`vendored path: ${entry.path} listed twice`);
      }
      seenPaths.add(entry.path);
      if (
        typeof entry.upstream !== "string" ||
        !entry.upstream.startsWith("src/")
      ) {
        fail(
          `vendored upstream: ${entry.path} must name its pinned-source file (src/…)`,
        );
      }
      if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
        fail(`vendored sha256: ${entry.path} must be a sha256 hex digest`);
      }
    }
  }

  const organization = m.organization;
  if (
    !organization ||
    typeof organization !== "object" ||
    Object.keys(organization).length === 0
  ) {
    fail("organization: no component declarations");
  } else {
    for (const [name, declaration] of Object.entries(organization)) {
      if (!declaration || !REUSE_VALUES.includes(declaration.reuse as never)) {
        fail(
          `organization ${name}: reuse must be one of ${REUSE_VALUES.join(", ")}`,
        );
        continue;
      }
      if (
        typeof declaration.upstream !== "string" ||
        !declaration.upstream.startsWith("src/")
      ) {
        fail(
          `organization ${name}: upstream must name its pinned-source file (src/…)`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The app's mount point for the fixed Better Auth UI: it reuses the existing
 * Router and QueryClient (it mounts none of its own) and refuses to render from
 * a manifest that is not exactly the pinned, digest-recorded source.
 */
export function OpenBotAuthProvider({
  children,
}: PropsWithChildren): ReactElement {
  const verdict = verifyUiSource(uiSource);
  if (!verdict.ok) {
    throw new Error(
      `OpenBotAuthProvider refuses to mount: the fixed BA UI source manifest is incompatible or unpinned — ${verdict.errors.join("; ")}`,
    );
  }
  return (
    <OpenBotAuthUIProvider source={uiSource}>{children}</OpenBotAuthUIProvider>
  );
}
