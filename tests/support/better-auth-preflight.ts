/*
 * The BA Web engine suites' shared preflight and suite guard (T04.12 / #563, plan F4:
 * 默认/BA Web/BA Mobile 互斥收集，强制 origin/digest/target preflight，零网络负例).
 *
 * The preflight runs where e2e.better-auth.config.ts loads it — before any engine is created and
 * any page is opened — so a BA Web run against no stack, a wrong origin, or a missing identity
 * fails at config load with zero navigation, not as a browser timeout somebody has to diagnose.
 * The guard runs at the top of every BA Web suite file: a file collected by any other config (a
 * widened glob, an explicit path argument) refuses to run rather than driving the wrong target.
 *
 * Both halves are injectable (env, fetch, suite token) so tests/e2e-browser-isolation.test.ts can
 * assert the refusals with a recording fetch and a mismatched token, with zero network of its own.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BA_WEB_SUITE_ID = "better-auth-web";
export const BA_WEB_TARGET_NAME = "better-auth-web";
export const BA_WEB_PREFLIGHT_ENV = {
  appOrigin: "BA_E2E_APP_ORIGIN",
  apiOrigin: "BA_E2E_API_ORIGIN",
  directoryEmail: "BA_E2E_DIRECTORY_EMAIL",
  directoryPassword: "BA_E2E_DIRECTORY_PASSWORD",
} as const;

const ROOT = resolve(import.meta.dirname, "../..");
const ENGINE_MANIFEST = "tests/config/e2e-engine-suites.json";

type Env = Record<string, string | undefined>;

/** A required origin: present, http(s) — or the refusal names the variable. Nothing is dialed. */
function requireOrigin(env: Env, variable: string): string {
  const raw = env[variable]?.trim();
  if (!raw) {
    throw new Error(
      `${variable} is not set: the BA Web engine suites refuse to start without it, before any engine or navigation. Point it at this run's BA stack (see docs/plans/tickets/better-auth/T04.12.md).`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${variable} is not an absolute URL: ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${variable} must be http(s), not ${JSON.stringify(parsed.protocol)}`,
    );
  }
  return parsed.origin;
}

/** The identity the BA Web suites sign in with: presence only — never returned, never printed. */
function requireIdentity(env: Env): void {
  for (const variable of [
    BA_WEB_PREFLIGHT_ENV.directoryEmail,
    BA_WEB_PREFLIGHT_ENV.directoryPassword,
  ]) {
    if (!env[variable]?.trim()) {
      throw new Error(
        `${variable} is not set: the BA Web engine suites sign in as this identity, and a run without it cannot execute a single suite. Provide it for this run; its value is never logged.`,
      );
    }
  }
}

export interface BaWebPreflightReport {
  readonly appOrigin: string;
  readonly apiOrigin: string;
  /** sha256 of the served app index, first 16 hex chars: pins which build the browser drove. */
  readonly appIndexDigest: string;
  /** The API origin's /health status field, which must answer ok. */
  readonly apiHealth: string;
}

/**
 * The full preflight: env, identity, app origin serving, API origin health, and the served app's
 * build digest. Every refusal names the variable or origin it is about. The env half is
 * synchronous and touches no network, so a missing-origin refusal happens before the first request
 * by construction — that ordering is what the isolation counterexample pins.
 */
export async function preflightBaWebEngine(options?: {
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<BaWebPreflightReport> {
  const env = options?.env ?? process.env;
  const fetchImpl = options?.fetchImpl ?? fetch;

  const appOrigin = requireOrigin(env, BA_WEB_PREFLIGHT_ENV.appOrigin);
  const apiOrigin = requireOrigin(env, BA_WEB_PREFLIGHT_ENV.apiOrigin);
  requireIdentity(env);

  const indexResponse = await fetchImpl(`${appOrigin}/`);
  if (!indexResponse.ok) {
    throw new Error(
      `${BA_WEB_PREFLIGHT_ENV.appOrigin} (${appOrigin}) answered ${indexResponse.status} on / — bring the BA app up before running browser suites`,
    );
  }
  const appIndexDigest = createHash("sha256")
    .update(await indexResponse.text())
    .digest("hex")
    .slice(0, 16);

  const healthResponse = await fetchImpl(`${apiOrigin}/health`);
  if (healthResponse.status !== 200) {
    throw new Error(
      `${BA_WEB_PREFLIGHT_ENV.apiOrigin} (${apiOrigin}) answered ${healthResponse.status} on /health — bring the BA API up before running browser suites`,
    );
  }
  const health = (await healthResponse.json()) as { status?: string };
  if (health.status !== "ok") {
    throw new Error(
      `${BA_WEB_PREFLIGHT_ENV.apiOrigin} (${apiOrigin}) /health does not say ok: ${JSON.stringify(health.status)}`,
    );
  }
  return { appOrigin, apiOrigin, appIndexDigest, apiHealth: "ok" };
}

/** `e2e list` collects and selects but starts no engine, no app process and no worker. */
function collectorOnlyRun(): boolean {
  return process.argv.some((argument) => argument === "list");
}

/**
 * The config's entry point. Collection runs (`e2e list`, and the audit's enumeration through it)
 * skip the preflight — listing a collector must not demand a live stack — while every executing
 * run keeps the full preflight, in the CLI process and again in every worker that re-resolves the
 * config. Awaited at the top of e2e.better-auth.config.ts, so the refusal precedes engine creation.
 */
export async function runBaWebPreflight(): Promise<BaWebPreflightReport> {
  if (collectorOnlyRun()) return collectorOnlyReport();
  const report = await preflightBaWebEngine();
  process.env.E2E_BA_WEB_BUILD_DIGEST = report.appIndexDigest;
  // One line in the run log, so a report can pin which build the browser actually drove.
  console.error(
    `[ba-web preflight] app ${report.appOrigin} index sha256:${report.appIndexDigest} · api ${report.apiOrigin}/health ok`,
  );
  return report;
}

function collectorOnlyReport(): BaWebPreflightReport {
  // Loopback placeholder, never dialed: e2e validates a web target's app.url shape even in
  // list mode, and plain HTTP is only accepted for loopback hosts.
  return {
    appOrigin: "http://127.0.0.1",
    apiOrigin: "http://127.0.0.1",
    appIndexDigest: "",
    apiHealth: "",
  };
}

/** The files registered under one suite in the engine manifest. */
export function engineSuiteFiles(suite: string): string[] {
  const parsed = JSON.parse(
    readFileSync(resolve(ROOT, ENGINE_MANIFEST), "utf8"),
  ) as { suites?: { name: string; files: string[] }[] };
  const entry = parsed.suites?.find((candidate) => candidate.name === suite);
  if (!entry) {
    throw new Error(`suite "${suite}" is not registered in ${ENGINE_MANIFEST}`);
  }
  return entry.files;
}

/**
 * The suite guard every BA Web engine file calls at import time. `file` is the module's own URL
 * (or an already-relative path); `token` defaults to the suite token the active config set, so a
 * mismatched config — one that never set `E2E_ENGINE_SUITE` to the BA Web suite — is refused with
 * zero network, at collection.
 */
export function assertBaWebSuite(
  file: string,
  token: string | undefined = process.env.E2E_ENGINE_SUITE,
): void {
  const suiteFile = file.includes("://")
    ? relative(ROOT, fileURLToPath(file))
    : file;
  if (token !== BA_WEB_SUITE_ID) {
    throw new Error(
      `${suiteFile} is a better-auth Web engine suite: run it with \`bun run test:ui:better-auth\` (e2e.better-auth.config.ts). The active engine-suite token is ${JSON.stringify(token)} — this file refuses to run under any other config or target.`,
    );
  }
  if (!engineSuiteFiles(BA_WEB_SUITE_ID).includes(suiteFile)) {
    throw new Error(
      `${suiteFile} is not registered under the ${BA_WEB_SUITE_ID} group in ${ENGINE_MANIFEST}; register the file with its own task before running it.`,
    );
  }
}
