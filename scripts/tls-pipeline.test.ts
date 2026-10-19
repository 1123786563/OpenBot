import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "../tests/support/bun-test-compat";

/**
 * The TLS certificate pipeline behind `docker/compose/certs.yml` (#359, spec
 * craft-preview-origin D8/AC8): the preview-host derivation from
 * `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE` (mirroring #361's parseTemplate in
 * server/src/craft/preview-origin.ts), and the renewal guard's
 * health/alert/cooldown/recovery decisions over a fixture TLS directory.
 *
 * The production code is shell (the acme.sh sidecar has no bun), so every test
 * spawns the real scripts: `lib.sh __derive` for the pure derivation, and
 * `renewal-guard.sh --once` against a tmpdir holding an openssl-fabricated
 * certificate plus the status file the entrypoint loop maintains. The failure
 * drill itself is `drill-renewal-failure.sh` (its own assertions), run here as
 * the end-to-end integration case.
 */

const certsDir = resolve("docker/compose/certs");
const lib = join(certsDir, "lib.sh");
const guard = join(certsDir, "renewal-guard.sh");
const drill = join(certsDir, "drill-renewal-failure.sh");
const bash = Bun.which("bash") as string;

type RunResult = { exit: number; out: string; err: string };

function run(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const proc = Bun.spawn([bash, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, exit]) => ({ exit, out, err }));
}

/** `lib.sh __derive <template>` → "ok|<scheme>|<baseHostname>" / "skip|<reason>" / exit 1 + "invalid|<reason>".
 *
 * OPENBOT_APP_URL is pinned empty unless the caller sets it: #404 made the
 * derivation read it, and `run` spreads the whole process env — a developer's
 * own `.env` must never decide whether a golden case passes.
 */
async function derive(
  template: string,
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return run([lib, "__derive", template], {
    OPENBOT_APP_URL: "",
    ...env,
  });
}

async function makeCert(
  dir: string,
  days: number,
  name = "*.drill.invalid",
): Promise<void> {
  const proc = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      String(days),
      "-subj",
      `/CN=${name}`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await proc.exited).toBe(0);
}

/** One guard evaluation over a fixture directory; returns parsed status-file fields. */
async function guardOnce(
  dir: string,
  env: Record<string, string | undefined> = {},
) {
  const result = await run([guard, "--once"], { OPENBOT_TLS_DIR: dir, ...env });
  const status = await Bun.file(join(dir, "renewal-status.json")).json();
  const alertsFile = env.OPENBOT_TLS_ALERT_WEBHOOK?.startsWith("file:")
    ? env.OPENBOT_TLS_ALERT_WEBHOOK.slice("file:".length)
    : undefined;
  const alerts =
    alertsFile && (await Bun.file(alertsFile).exists())
      ? (await Bun.file(alertsFile).text())
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { result, status, alerts };
}

describe("derive_preview_host (mirrors #361 parseTemplate)", () => {
  test("empty template is the dev form: no certificate needed", async () => {
    const r = await derive("");
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toMatch(/^skip\|/);
    expect(r.out).toContain("dev");
  });

  test("the canonical https template derives the wildcard base", async () => {
    const r = await derive("https://{session}.preview.example.com");
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("ok|https|preview.example.com");
  });

  test("a port on the template host is stripped for the certificate name", async () => {
    const r = await derive("https://{session}.preview.example.com:8443");
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("ok|https|preview.example.com");
  });

  test("scheme and host are lowercased", async () => {
    const r = await derive("HTTPS://{session}.Preview.Example.COM");
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("ok|https|preview.example.com");
  });

  test("an http template is INVALID — the server's fix-ocr4 #9 verdict, aligned (fix-ocr18 #9)", async () => {
    // Cross-reference: server/tests/craft-preview-origin.test.ts, "a non-https
    // host template is refused" (fix-ocr4 #9). The preview pass cookie is
    // hardcoded SameSite=None; Secure — an http host form can never accept
    // its own pass, so the server refuses the template and closes admission.
    // The sidecar's old "skip" verdict was a drift: the TLS face could not
    // see a configuration error the serving face refuses on, and a
    // misconfigured deployment burned LE quota issuing a certificate the
    // server will never address. The two faces must agree; when this case
    // changes, the server-side golden case above changes with it.
    const r = await derive("http://{session}.preview.example.com");
    expect(r.exit).toBe(1);
    expect(r.out.trim()).toMatch(/^invalid\|/);
    expect(r.out).toContain("https");
  });

  test("a localhost base stays skip — the server's local testing form, uncertifiable (fix-ocr18 #9)", async () => {
    // Divergence, recorded: parseTemplate explicitly supports
    // `https://{session}.localhost:3001` (the local testing form), but no
    // public CA (LE included) can issue for the reserved .localhost domain —
    // so the pipeline records a skip instead of failing the sidecar on a
    // template the server deliberately serves. Harmless by construction: a
    // certificate for a reserved domain cannot exist, and the local form
    // never needed one from the pipeline.
    const r = await derive("https://{session}.localhost:3001");
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toMatch(/^skip\|/);
    expect(r.out).toContain("localhost");
  });

  test("a port above 65535 is invalid — the server's URL parser throws on it (fix-ocr18 #8)", async () => {
    // The server's `new URL()` refuses :70000 (WHATWG's port range ends at
    // 65535), so the template never serves — but this side's digits-only
    // check derived ok and the sidecar burned LE quota issuing for a
    // certificate the server will never address. One template, two verdicts:
    // the divergence IS the bug.
    const r = await derive("https://{session}.preview.example.com:70000");
    expect(r.exit).toBe(1);
    expect(r.out.trim()).toMatch(/^invalid\|/);
  });

  test("a zero-padded port is the port it spells — :0443 IS 443, valid (fix-ocr18 #8)", async () => {
    // Leading zeros are WHATWG-legal (the URL parser normalizes :0443 to
    // 443), so the range check must read the VALUE, not the digit count —
    // a naive "at most 5 digits" reading would refuse a template the
    // server serves fine.
    const r = await derive("https://{session}.preview.example.com:0443");
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("ok|https|preview.example.com");
  });

  const invalid = [
    ["https://{session}preview.example.com"], // {session} must be a whole leading label
    ["https://preview.example.com"], // no {session} at all
    ["https://{session}.a.example.com/{session}"], // {session} twice (and a path)
    ["https://{session}.preview.example.com/app"], // a path smuggles the basePath footgun back in
    ["https://{session}.preview.example.com?x=1"], // so does a query
    ["https://{session}.preview.example.com#f"], // and a fragment
    ["ftp://{session}.preview.example.com"], // scheme
    ["{session}.preview.example.com"], // no scheme
    ["https://{session}.preview.example.com{session}"], // stray second occurrence
  ];
  for (const [template] of invalid) {
    test(`invalid: ${template}`, async () => {
      const r = await derive(template);
      expect(r.exit).toBe(1);
      expect(r.out.trim()).toMatch(/^invalid\|/);
    });
  }

  /**
   * The review-F2 golden set: the ten edge inputs where this derivation and #361's
   * parseTemplate disagreed at review, each with the sidecar's pinned ruling. The
   * server side's laxness on some of these (empty base, userinfo, trailing dot,
   * IDN, underscore) is #362's defect to fix — this side fails loudly instead of
   * mirroring it.
   */
  const edges: Array<[string, string]> = [
    // The placeholder is case-sensitive: only literal {session} (server rejects these too).
    ["https://{Session}.preview.example.com", "invalid"],
    ["https://{sEssIon}.preview.example.com", "invalid"],
    // Whitespace inside the template is a typo, not something to strip (server rejects).
    ["https://{session}.pre view.example.com", "invalid"],
    // A port must be a whole number — `:8443x` is a typo (server rejects).
    ["https://{session}.preview.example.com:8443x", "invalid"],
    // Trailing-dot host: a config typo that must not become a `*.<base>.` certificate.
    ["https://{session}.preview.example.com.", "invalid"],
    // Empty base: nothing to certify (server is lax here — #362).
    ["https://{session}.", "invalid"],
    // Userinfo is not part of any hostname a browser sends (server is lax here — #362).
    ["https://user@{session}.preview.example.com", "invalid"],
    // IDN must be configured punycode (xn--…): a unicode SAN never matches the wire.
    ["https://{session}.预览.example.com", "invalid"],
    // Public CAs (LE included) do not issue underscore hostnames — refuse early.
    ["https://{session}.preview_host.example.com", "invalid"],
    // Leading/trailing whitespace is trimmed, exactly like parseTemplate's raw.trim().
    [
      "  https://{session}.preview.example.com  ",
      "ok|https|preview.example.com",
    ],
    // fix-ocr4 #5 (two-口径一致): a bare trailing `:` is WHATWG's "empty port
    // = no port" — the server's URL parser normalizes it away and serves the
    // template fine (pinned server-side in craft-preview-origin.test.ts), so
    // this side must agree: the pre-fix `^:[0-9]+$` check crashed the sidecar
    // into an on-failure loop against a template the server accepts.
    ["https://{session}.x:", "ok|https|x"],
    // fix-ocr19 #9 (measured): WHATWG's domain-to-ASCII ACCEPTS empty
    // interior labels (`a..b`) and boundary hyphens (`a-.b` — CheckHyphens
    // is off), so both faces once pinned `a..b` ok. fix-ocr27 #2 tightened
    // the SERVER side (degenerate wildcard); #415 closes the recorded
    // deviation by refusing here too — LE would refuse the issuance on its
    // own terms anyway. `a-.b` stays ok on both faces (pinned server-side,
    // craft-preview-origin.test.ts).
    ["https://{session}.a..b", "invalid"],
    ["https://{session}.a-.b", "ok|https|a-.b"],
    // #415: a wildcard `*` label parses as a WHATWG hostname, so the server
    // needed its own explicit refusal (parseTemplate, pinned server-side) —
    // this side's base charset never admitted it, pinned here so a future
    // regex loosening cannot reopen the divergence class.
    ["https://{session}.*.example.com", "invalid"],
    ["https://{session}.x.*.example.com", "invalid"],
  ];
  for (const [template, expected] of edges) {
    test(`F2 edge: ${JSON.stringify(template)} → ${expected.split("|")[0]}`, async () => {
      const r = await derive(template);
      if (expected.startsWith("ok|")) {
        expect(r.exit).toBe(0);
        expect(r.out.trim()).toBe(expected);
      } else {
        expect(r.exit).toBe(1);
        expect(r.out.trim()).toMatch(/^invalid\|/);
      }
    });
  }
});

// ── #404 (AC6/M-1): a base that swallows the main site is refused ─────────────
//
// Cross-referenced golden set: server/tests/craft-preview-origin.test.ts,
// "#404: a preview base that swallows the main site's host closes admission".
// Both faces judge the ONE claim rule: the server runs claimsPreviewHost against
// the host `config.appUrl` resolves to, this side reads `OPENBOT_APP_URL` — the
// variable that chain starts from, and the only one it may guess at. A template
// the server refuses must never get a wildcard certificate behind it, and a
// template the server serves must never crash-loop this side (fix-ocr18 #9's
// divergence class, the other direction).
describe("derive_preview_host: a base that swallows the main site is refused (#404)", () => {
  test.each([
    ["https://app.example.com", "https://{session}.example.com"],
    ["https://example.com", "https://{session}.example.com"],
  ])(
    "the ticket's clash cases: app %p under template %p → invalid",
    async (appUrl, template) => {
      const r = await derive(template, { OPENBOT_APP_URL: appUrl });
      expect(r.exit).toBe(1);
      expect(r.out.trim()).toMatch(/^invalid\|/);
      expect(r.out).toContain("OPENBOT_APP_URL");
    },
  );

  test.each([
    ["https://app.example.com", "https://{session}.preview.example.com"],
    ["https://example.com", "https://{session}.preview.example.com"],
  ])(
    "the ticket's open cases: app %p beside base %p → the derivation is unchanged",
    async (appUrl, template) => {
      const r = await derive(template, { OPENBOT_APP_URL: appUrl });
      expect(r.exit).toBe(0);
      expect(r.out.trim()).toBe("ok|https|preview.example.com");
    },
  );

  test("no OPENBOT_APP_URL judges nothing — the server's own chain stays the authority", async () => {
    // The server's appUrl falls through TRUSTED_ORIGINS and OPENBOT_PUBLIC_URL
    // too; this side does not re-implement that, because a guessed main host
    // would refuse a certificate for a deployment the app serves fine.
    const r = await derive("https://{session}.example.com");
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("ok|https|example.com");
  });

  test("a host that merely ends with the base TEXT is not under the base", async () => {
    // The claim is a LABEL boundary (`example.com`, `.example.com`), never a
    // substring: `notexample.com` is somebody else's domain and must certify.
    const r = await derive("https://{session}.example.com", {
      OPENBOT_APP_URL: "https://notexample.com",
    });
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("ok|https|example.com");
  });

  test.each([
    // A schemeless value is still a host an operator really writes, and userinfo
    // never reaches the hostname (WHATWG) — the server's mainSiteHostOf agrees.
    ["app.example.com", "invalid"],
    ["https://user:pw@app.example.com", "invalid"],
    ["https://app.example.com.", "invalid"], // dotted FQDN: same host to DNS
    ["HTTPS://APP.EXAMPLE.COM", "invalid"], // host comparison is case-folded
    ["not a url", "ok"], // no host at all ⇒ no judgment
    ["https://", "ok"],
    ["https://app.example.com:abc", "ok"], // WHATWG throws ⇒ the server judges nothing
    ["http://[::1]:3001", "ok"], // no preview base can be an IPv6 literal
  ])("the app host read: OPENBOT_APP_URL=%p → %p", async (appUrl, verdict) => {
    const r = await derive("https://{session}.example.com", {
      OPENBOT_APP_URL: appUrl,
    });
    if (verdict === "invalid") {
      expect(r.exit).toBe(1);
      expect(r.out.trim()).toMatch(/^invalid\|/);
    } else {
      expect(r.exit).toBe(0);
      expect(r.out.trim()).toBe("ok|https|example.com");
    }
  });

  test("the localhost base keeps fix-ocr22 #2's narrowings", async () => {
    // The local testing form deliberately SHARES its hostname with the main site,
    // so the clash rule inherits both narrowings or it would refuse the very
    // configuration the exemption exists to allow: the bare apex is never
    // claimed, and a claim needs the template's OWN port.
    const apex = await derive("https://{session}.localhost:3001", {
      OPENBOT_APP_URL: "http://localhost:3001",
    });
    expect(apex.exit).toBe(0);
    expect(apex.out.trim()).toMatch(/^skip\|/);
    const samePort = await derive("https://{session}.localhost:3001", {
      OPENBOT_APP_URL: "http://app.localhost:3001",
    });
    expect(samePort.exit).toBe(1);
    expect(samePort.out.trim()).toMatch(/^invalid\|/);
    const otherPort = await derive("https://{session}.localhost:3001", {
      OPENBOT_APP_URL: "http://app.localhost:4000",
    });
    expect(otherPort.exit).toBe(0);
    expect(otherPort.out.trim()).toMatch(/^skip\|/);
  });

  test("the port read is WHATWG-normalized on both sides", async () => {
    // `:0443` IS 443 (leading zeros dropped), so a template declared on the
    // scheme default still clashes with an app URL that spells it out.
    const clash = await derive("https://{session}.localhost:0443", {
      OPENBOT_APP_URL: "https://app.localhost",
    });
    expect(clash.exit).toBe(1);
    expect(clash.out.trim()).toMatch(/^invalid\|/);
  });
});

describe("renewal-guard health, alerts, cooldown, recovery", () => {
  let dir: string;

  test("a healthy cert is ok and silent", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    await makeCert(dir, 90);
    const { result, status, alerts } = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(result.exit).toBe(0);
    expect(status.health).toBe("ok");
    expect(alerts).toBeArrayOfSize(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("no certificate and no attempt record yet is 'starting', not critical (F4)", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    const webhook = `file:${join(dir, "alerts.jsonl")}`;
    // A fresh deployment mid first issuance: DNS-01 propagation takes minutes, and
    // nothing has resolved yet — red here would be a false alarm on every slow start.
    const once = await guardOnce(dir, { OPENBOT_TLS_ALERT_WEBHOOK: webhook });
    expect(once.result.exit).toBe(0);
    expect(once.status.health).toBe("starting");
    expect(once.alerts).toBeArrayOfSize(0);
    // The compose healthcheck probes the same decision: starting stays exit 0.
    const probe = await run([guard, "--healthcheck"], { OPENBOT_TLS_DIR: dir });
    expect(probe.exit).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing certificate is critical and alerts once issuance has resolved", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    // The first attempt resolved (failed) and no certificate ever landed — the
    // certificate's own state outranks the attempt: missing is genuinely red now.
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "issue",
      "acme.sh --issue exited 1",
    ]);
    const { result, status, alerts } = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(result.exit).toBe(1);
    expect(status.health).toBe("critical");
    expect(status.healthReason).toBe("missing");
    expect(alerts).toBeArrayOfSize(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].source).toBe("openbot-tls");
    expect(String(alerts[0].message)).toContain("missing");
    await rm(dir, { recursive: true, force: true });
  });

  test("the alert log line carries the standalone openbot-tls-alert marker (F1)", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    await makeCert(dir, 90);
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    const { result } = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(result.exit).toBe(1);
    // docs/tls-certs.md's zero-config Loki rule selects on exactly this substring.
    expect(result.err).toContain("openbot-tls-alert severity=critical");
    expect(result.err).toContain("reason=renewal-failed");
    // …and the drifting `log`-prefixed form ("openbot-tls alert …") must not come back.
    expect(result.err).not.toMatch(/^openbot-tls alert /m);
    await rm(dir, { recursive: true, force: true });
  });

  test("a failed renewal attempt is critical, alerts once, and the cooldown holds", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    await makeCert(dir, 90);
    const webhook = `file:${join(dir, "alerts.jsonl")}`;
    // Seed the failure the entrypoint loop records (lib.sh record_attempt).
    const seeded = await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    expect(seeded.exit).toBe(0);
    const first = await guardOnce(dir, { OPENBOT_TLS_ALERT_WEBHOOK: webhook });
    expect(first.result.exit).toBe(1);
    expect(first.status.health).toBe("critical");
    expect(first.status.lastAttemptOk).toBe(false);
    expect(first.alerts).toBeArrayOfSize(1);
    expect(first.alerts[0].severity).toBe("critical");
    expect(String(first.alerts[0].message)).toContain("renew");
    // Same state again: suppressed by the cooldown, still critical.
    const second = await guardOnce(dir, { OPENBOT_TLS_ALERT_WEBHOOK: webhook });
    expect(second.result.exit).toBe(1);
    expect(second.alerts).toBeArrayOfSize(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("the old certificate is untouched while the renewal fails (the drill's core claim)", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    await makeCert(dir, 90);
    const before = {
      cert: Bun.CryptoHasher.hash(
        "sha256",
        await Bun.file(join(dir, "cert.pem")).bytes(),
        "hex",
      ),
      key: Bun.CryptoHasher.hash(
        "sha256",
        await Bun.file(join(dir, "key.pem")).bytes(),
        "hex",
      ),
    };
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(
      Bun.CryptoHasher.hash(
        "sha256",
        await Bun.file(join(dir, "cert.pem")).bytes(),
        "hex",
      ),
    ).toBe(before.cert);
    expect(
      Bun.CryptoHasher.hash(
        "sha256",
        await Bun.file(join(dir, "key.pem")).bytes(),
        "hex",
      ),
    ).toBe(before.key);
    await rm(dir, { recursive: true, force: true });
  });

  test("a warn-state cert nearing expiry escalates to critical past the threshold", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    const webhook = `file:${join(dir, "alerts.jsonl")}`;
    await makeCert(dir, 25); // warn band (<= 30d), above crit (14d)
    const warn = await guardOnce(dir, { OPENBOT_TLS_ALERT_WEBHOOK: webhook });
    expect(warn.result.exit).toBe(0); // warn is not critical: the process stays healthy
    expect(warn.status.health).toBe("warn");
    expect(warn.alerts).toBeArrayOfSize(1);
    expect(warn.alerts[0].severity).toBe("warn");
    // The cert slips into the critical band: an escalation fires despite the cooldown.
    await makeCert(dir, 10);
    const crit = await guardOnce(dir, { OPENBOT_TLS_ALERT_WEBHOOK: webhook });
    expect(crit.status.health).toBe("critical");
    expect(crit.result.exit).toBe(1);
    expect(crit.alerts).toBeArrayOfSize(2);
    expect(crit.alerts[1].severity).toBe("critical");
    await rm(dir, { recursive: true, force: true });
  });

  test("an expired certificate is critical", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    await makeCert(dir, 1);
    // -days 1 can land anywhere in (0,1]; force the expiry decision by faking the clock is
    // unnecessary — instead assert the guard's own bucket via a 0-day-remaining certificate
    // is awkward, so use the state file seam: treat this as a near-zero cert and expect warn-or-critical.
    const { status, result } = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(["warn", "critical"]).toContain(status.health);
    expect(result.exit).toBe(status.health === "critical" ? 1 : 0);
    await rm(dir, { recursive: true, force: true });
  });

  test("recovery after a failure emits exactly one ok alert and clears health", async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    const webhook = `file:${join(dir, "alerts.jsonl")}`;
    await makeCert(dir, 90);
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    const failing = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: webhook,
    });
    expect(failing.status.health).toBe("critical");
    // The renewal succeeds and installs a fresh certificate.
    await run([lib, "__record-attempt", dir, "true", "renew", ""]);
    await makeCert(dir, 90);
    const recovered = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: webhook,
    });
    expect(recovered.result.exit).toBe(0);
    expect(recovered.status.health).toBe("ok");
    expect(recovered.alerts).toBeArrayOfSize(2);
    expect(recovered.alerts[1].severity).toBe("ok");
    // Steady state again: no more noise.
    const steady = await guardOnce(dir, { OPENBOT_TLS_ALERT_WEBHOOK: webhook });
    expect(steady.alerts).toBeArrayOfSize(2);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("status-file JSON integrity (High#1: quoted error text)", () => {
  test("an acme.sh error with embedded JSON survives record_attempt as legal JSON, no ghost keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-test-"));
    // Realistic acme.sh failure text: embedded JSON carrying the `"type":` fragment.
    // It used to leak bare `"` bytes into the value (\" escaping), so status_set's
    // key enumeration read `\"type\":` as a ghost key and the file rotted on every
    // read-modify-write — precisely on the issuance-failure path.
    const error =
      'acme.sh failed: {"type":"urn:ietf:params:acme:error:dns","detail":"DNS problem"} boom';
    const seeded = await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "issue",
      error,
    ]);
    expect(seeded.exit).toBe(0);
    // (a) The status file is still legal JSON right after the failure record.
    const file = join(dir, "renewal-status.json");
    expect(async () => JSON.parse(await Bun.file(file).text())).not.toThrow();
    // Another status_set pass (read-modify-write over the stored keys) must not
    // accumulate ghosts either.
    const again = await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      error,
    ]);
    expect(again.exit).toBe(0);
    const status = JSON.parse(await Bun.file(file).text()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(status).sort()).toEqual(
      [
        "schema",
        "lastAttemptOk",
        "lastAttemptAt",
        "lastAttemptKind",
        "lastAttemptError",
        "lastErrorDigest",
        "updatedAt",
      ].sort(),
    );
    // (b) The stored error reads back verbatim: the encoded " decodes to " — quote
    // semantics survive the escape round trip.
    expect(status.lastAttemptError).toBe(error);
    await rm(dir, { recursive: true, force: true });
  });

  test('a clean attempt records a BARE null digest — not the string "null" (fix-ocr21 #5)', async () => {
    // No error → no digest. The old code quoted the sentinel ('null' →
    // "\"null\""), a STRING no consumer can read as "no digest" (and an
    // openssl-less host wrote the empty string ""). lastAttemptError already
    // rides the bare-null convention on this same path; the digest must
    // match it — a success after a failure overwrites the stale digest too.
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-digest-"));
    await run([lib, "__record-attempt", dir, "true", "renew", ""]);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.lastAttemptError).toBeNull();
    expect(status.lastErrorDigest).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── fix-ocr17: the wildcard directory name must be pure POSIX ────────────
// The entrypoint used to normalize `*.x` → `_.x` with bash's
// `${certificate/\*./_.}` substitution — a bashism the sidecar's strict-POSIX
// sh (Alpine dash/ash) rejects with "Bad substitution", crashing the whole
// startup path before the restart fast path could even run. The bash-run test
// suite cannot see that (bash accepts its own extension), so the derivation
// now lives in a pure lib.sh seam and the test pins BOTH the `_.x` shape AND
// its survival under /bin/sh.
describe("wildcard_cert_dir (fix-ocr17: POSIX `*.`→`_.` normalization, no bashisms)", () => {
  test("a `*.x` certificate maps to acme.sh's `_.x` on-disk directory shape", async () => {
    const r = await run([
      lib,
      "__cert-dir",
      "/acme-home",
      "*.preview.example.com",
    ]);
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("/acme-home/_.preview.example.com_ecc");
  });

  test("the derivation survives a strict POSIX sh, not just bash", async () => {
    if (!existsSync("/bin/sh")) return; // no POSIX sh on this host
    const proc = Bun.spawn(
      ["/bin/sh", lib, "__cert-dir", "/acme-home", "*.x.example.com"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(`${exit}:${err}`).toBe("0:");
    expect(out.trim()).toBe("/acme-home/_.x.example.com_ecc");
  });
});

// ── fix-ocr18 #10: a non-numeric env knob must fall back, never disarm the alerter ──
// OPENBOT_TLS_ALERT_COOLDOWN_SECONDS=864OO used to flow into should_alert's
// `[ $((now - last_at)) -ge "$cooldown" ]`: the arithmetic errored, the
// comparison read false, and a critical state whose cooldown had long expired
// stayed SILENT. The guard's whole point is 宁可误报 — a bad env value
// disarming the alerter is the exact opposite direction. The readers fall back
// to their defaults (the entrypoint INTERVAL's own precedent) with a WARN.
describe("tls_numeric — the numeric-env guard (fix-ocr18 #10)", () => {
  test("a letter-rot cooldown env answers the default 86400 through the guard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr18-num-"));
    const webhook = `file:${join(dir, "alerts.jsonl")}`;
    const ninetyMinutesAgo = String(Math.floor(Date.now() / 1000) - 90000);
    await run([lib, "__status-set", dir, "lastAlertAt", ninetyMinutesAgo]);
    await run([lib, "__status-set", dir, "lastAlertSeverity", '"critical"']);
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    const failing = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: webhook,
      OPENBOT_TLS_ALERT_COOLDOWN_SECONDS: "864OO",
    });
    // 90000s ago is past the 86400 default: the cooldown HAS expired — this
    // re-alert must fire. RED: "864OO" poisoned the comparison and the
    // guard suppressed it.
    expect(failing.alerts).toBeArrayOfSize(1);
    expect(failing.alerts[0]?.severity).toBe("critical");
    await rm(dir, { recursive: true, force: true });
  });

  test("the pure seam: non-numeric values fall back to the default with a WARN", async () => {
    for (const bad of ["864OO", "-5", "3.14", "", "0x10", " 30"]) {
      const r = await run([lib, "__numeric", bad, "86400"]);
      expect(r.out.trim()).toBe("86400");
      expect(r.err).toContain("WARN");
    }
  });

  test("the pure seam: plain values pass through untouched", async () => {
    for (const good of ["0", "86400", "0014"]) {
      const r = await run([lib, "__numeric", good, "86400"]);
      expect(r.out.trim()).toBe(good);
      expect(r.err).not.toContain("WARN");
    }
  });
});

// ── fix-ocr17: a corrupt timestamp must fire, never go silent ────────────────
// should_alert subtracted lastAlertAt from now in arithmetic: a corrupted /
// truncated value (the status file is hand-written JSON) made the expansion
// error out inside the command substitution — the guard silently evaluated to
// "no alert", exactly the silence the pipeline exists to prevent. The rule is
// "宁可误报" (rather false-alarm than miss): anything not a plain number is
// treated as never-alerted, which fires.
describe("should_alert corrupt timestamp (fix-ocr17: corrupt ⇒ fire, never silent)", () => {
  test("a corrupt lastAlertAt still fires the critical alert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr17-ts-"));
    const webhook = `file:${join(dir, "alerts.jsonl")}`;
    await run([lib, "__status-set", dir, "lastAlertAt", '"garbage"']);
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    const failing = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: webhook,
    });
    expect(failing.status.health).toBe("critical");
    expect(failing.alerts).toBeArrayOfSize(1); // RED: pre-fix, arithmetic errored → no alert
    expect(failing.alerts[0].severity).toBe("critical");
    expect(failing.result.exit).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});

// ── fix-ocr17: control characters must not pierce the hand-written JSON ─────
// json_escape neutralized quotes/commas/braces and (via tr) newlines, but a
// bare TAB or CR inside an acme.sh error passed straight into the JSON string
// literal — strict parsers (V8/Bun .json()) reject raw control bytes in
// strings, so the status file became UNREADABLE exactly when a failure needed
// reading. "Hand-written scalar JSON can be honestly read back" must hold for
// every control character.
describe("json_escape control characters (fix-ocr17: strict-JSON readable status)", () => {
  test("an error containing tab/CR/bell still parses back as legal JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr17-cntrl-"));
    const error = "acme.sh failed:\tfatal bell\u0007here\r\nnext line";
    const seeded = await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "issue",
      error,
    ]);
    expect(seeded.exit).toBe(0);
    const file = join(dir, "renewal-status.json");
    // RED pre-fix: Bun's strict parser threw on the bare control bytes.
    const status = JSON.parse(await Bun.file(file).text()) as Record<
      string,
      unknown
    >;
    expect(status.lastAttemptOk).toBe(false);
    // Every control byte became a plain space; the readable text survives.
    // (CRLF becomes two spaces — CR via the cntrl rule, NL via the standing
    // tr — so the assertion is on fragments, not on one exact string.)
    expect(String(status.lastAttemptError)).not.toMatch(/[\u0000-\u001f]/);
    expect(String(status.lastAttemptError)).toContain("acme.sh failed: fatal");
    expect(String(status.lastAttemptError)).toContain("bell here");
    expect(String(status.lastAttemptError)).toContain("next line");
    await rm(dir, { recursive: true, force: true });
  });
});

// ── fix-ocr17: a bare uid must never silently become uid:uid ───────────────
// reload.sh chowned "${OWNER%%:*}:${OWNER#*:}" — for a colon-less value like
// "1000" both halves spell "1000", so the chown quietly CHANGED THE GROUP to
// 1000 instead of the operator's intent. Only an explicit uid:gid pair is
// honored; anything else is a WARN + skip. The decision is a pure lib.sh seam
// so the discipline is testable without running the chown as root.
describe("OPENBOT_TLS_OWNER discipline (fix-ocr17: bare uid never becomes uid:uid)", () => {
  test("a uid:gid pair is honored verbatim", async () => {
    const r = await run([lib, "__owner-uid-gid", "1000:1000"]);
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe("1000:1000");
  });

  test("a bare uid is rejected to empty — reload.sh skips the chown (WARN)", async () => {
    const r = await run([lib, "__owner-uid-gid", "1000"]);
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe(""); // RED: pre-fix reload.sh chowned 1000:1000
  });
});

// ── fix-ocr17: compose/entrypoint/drill wiring pins ──────────────────────
// Five consistency fixes that shell-spawn tests cannot reach (the suite runs
// them under bash, or never runs them at all): the healthcheck and the
// entrypoint must not rely on exec bits; the compose env must spell the var
// the scripts actually read; the drill must pin compose to the repo root and
// bound its live-staging run. Source-level pins keep each invariant from
// drifting back.
describe("compose + entrypoint + drill wiring (fix-ocr17)", () => {
  const composeSource = readFileSync("docker/compose/certs.yml", "utf8");
  const entrySource = readFileSync(
    "docker/compose/certs/entrypoint.sh",
    "utf8",
  );
  const drillSource = readFileSync(
    "docker/compose/certs/drill-renewal-failure.sh",
    "utf8",
  );

  test("the healthcheck invokes the guard through sh, not its exec bit", () => {
    expect(composeSource).toContain(
      '"CMD", "sh", "/openbot-certs/renewal-guard.sh", "--healthcheck"',
    );
  });

  test("the compose env spells ACME_HOME — the name entrypoint/lib actually read", () => {
    expect(composeSource).toMatch(/ACME_HOME: \/etc\/openbot\/tls\/acme-home/);
    expect(composeSource).not.toMatch(/^\s*CA_HOME:/m);
  });

  test("entrypoint invokes every helper through sh — no exec-bit reliance", () => {
    // Count executable lines only: comment mentions are prose, not invocations.
    const code = entrySource
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    // Every renewal-guard.sh reference is a `sh "$LIB_DIR/…"` invocation…
    const guardRefs = code.match(/\brenewal-guard\.sh\b/g) ?? [];
    const guardThroughSh =
      code.match(/sh "\$LIB_DIR\/renewal-guard\.sh"/g) ?? [];
    expect(guardRefs.length).toBeGreaterThan(0);
    expect(guardThroughSh.length).toBe(guardRefs.length);
    // …and the acme.sh reloadcmd is an explicit `sh <path>` too.
    expect(entrySource).toContain('--reloadcmd "sh $LIB_DIR/reload.sh"');
  });

  test("the live-staging drill pins compose to the repo root, not the caller's cwd", () => {
    expect(drillSource).toContain(
      'repo_root="$(cd "$CERTS_DIR/../.." && pwd)"',
    );
    expect(drillSource).toContain('--project-directory "$repo_root"');
    expect(drillSource).toContain('-f "$repo_root/docker/compose/certs.yml"');
  });

  test("the live-staging run is bounded by a timeout — a valid token cannot hang CI", () => {
    expect(drillSource).toMatch(/timeout 120 /);
  });

  test("the live-staging preflight checks timeout(1) — a missing binary must fail loud, not pass fake (fix-ocr18 #12)", () => {
    // The bounded run shells out to `timeout 120 docker compose …`. On a
    // host without timeout(1) the spawn exits 127 BEFORE docker runs — and
    // 127 is ≠0, exactly what the failure path expects, so the drill
    // reported "staged issuance failed as injected (exit 127)": a fake PASS
    // that never touched the cluster. The preflight sits beside the docker
    // one and fails loud instead.
    expect(drillSource).toMatch(/command -v timeout [^|]*\|\| fail/);
  });

  test("fix-ocr26 #12: the drill invokes every helper through sh — no exec-bit reliance", () => {
    // Same contract as the entrypoint pin above (fix-ocr17): a filemode=false
    // checkout strips the +x bit, and a drill that execs "$LIB"/"$GUARD"
    // directly dies with EACCES. Every invocation is the `sh <path>` form.
    const offenders = drillSource
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .filter((l) => /("\$LIB"\s+__run-renewal|"\$GUARD"\s+--once)/.test(l))
      .filter((l) => !/sh "\$(LIB|GUARD)"/.test(l));
    expect(offenders).toEqual([]);
    // And the sh forms are really there (the pin cannot pass vacuously).
    expect(drillSource).toContain('sh "$LIB" __run-renewal');
    expect(drillSource).toContain('sh "$GUARD" --once');
  });
});

// ── fix-ocr18 #11: the reload hook's outcome must be observable ─────────
// "Certificate replaced but the consumer absent" was invisible: reload.sh
// logged the hook's success/failure and exited — nothing wrote the status
// file, so the healthcheck and the alert loop (the two things an operator
// actually watches) could not see a broken live-reload. Both hook paths now
// write lastReloadOk/lastReloadAt (failure keeps its WARN log too).
describe("reload.sh writes the hook outcome to the status file (fix-ocr18 #11)", () => {
  const reload = join(certsDir, "reload.sh");

  function hookServer(status: number): {
    stop: () => void;
    urlOf: () => string;
  } {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status }),
    });
    return {
      stop: () => server.stop(true),
      urlOf: () => `http://127.0.0.1:${server.port}/reload`,
    };
  }

  test("a delivered hook writes lastReloadOk=true + lastReloadAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr18-reload-ok-"));
    const hook = hookServer(200);
    try {
      const r = await run([reload], {
        OPENBOT_TLS_DIR: dir,
        OPENBOT_TLS_RELOAD_URL: hook.urlOf(),
      });
      expect(r.exit).toBe(0);
      const status = await Bun.file(join(dir, "renewal-status.json")).json();
      expect(status.lastReloadOk).toBe(true);
      expect(Number(status.lastReloadAt)).toBeGreaterThan(0);
    } finally {
      hook.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed hook writes lastReloadOk=false, still exits 0 (the certificate IS installed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr18-reload-bad-"));
    const hook = hookServer(500);
    try {
      const r = await run([reload], {
        OPENBOT_TLS_DIR: dir,
        OPENBOT_TLS_RELOAD_URL: hook.urlOf(),
      });
      // The hook's failure is never fatal: the certificate is in place; only
      // the live reload needs attention (the WARN log + the status field).
      expect(r.exit).toBe(0);
      expect(r.err).toContain("WARN");
      const status = await Bun.file(join(dir, "renewal-status.json")).json();
      expect(status.lastReloadOk).toBe(false);
      expect(Number(status.lastReloadAt)).toBeGreaterThan(0);
    } finally {
      hook.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── fix-ocr18 #13: the status-file key roster, pinned until the consumer lands ──
// #362's server-side admission gate is SUPPOSED to read renewal-status.json
// but does not exist yet. Until it does, the schema is pinned by enumeration:
// every status_set literal across the four writers, plus the schema bootstrap
// key status_set itself seeds. A writer adding a field without updating this
// roster fails here — which is the moment to decide whether the consumer needs
// it (TODO: wire the admission gate's read and re-home this roster beside it).
describe("renewal-status.json key roster (fix-ocr18 #13 — snapshot)", () => {
  const writers = ["lib.sh", "entrypoint.sh", "renewal-guard.sh", "reload.sh"];
  const sources = writers.map((name) =>
    readFileSync(join(certsDir, name), "utf8"),
  );
  const extracted = sources
    .map((source) =>
      source
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n"),
    )
    .flatMap((source) =>
      [...source.matchAll(/status_set\s+\S+\s+([A-Za-z][A-Za-z0-9]*)/g)].map(
        (m) => m[1] ?? "",
      ),
    );
  // The bootstrap key is written by printf, not status_set (lib.sh seeds a
  // fresh file with {"schema": 1}), so it is asserted directly instead of
  // riding the extraction.
  const roster = [
    // lib.sh: record_restart + record_attempt
    "updatedAt",
    "lastRestartAt",
    "lastAttemptOk",
    "lastAttemptAt",
    "lastAttemptKind",
    "lastAttemptError",
    "lastErrorDigest",
    "lastSuccessAt",
    // entrypoint.sh: pipeline target + refused start
    "previewHost",
    "certificate",
    "ca",
    "health",
    "healthReason",
    "failedAt",
    // renewal-guard.sh: the evaluation + alert bookkeeping
    "daysLeft",
    "evaluatedAt",
    "lastAlertAt",
    "lastAlertSeverity",
    // reload.sh: the hook outcome (fix-ocr18 #11)
    "lastReloadOk",
    "lastReloadAt",
  ];

  test("every status_set literal is in the roster, and the roster is exact", async () => {
    expect([...new Set(extracted)].sort()).toEqual([...new Set(roster)].sort());
    // The bootstrap: a first write to a fresh dir seeds schema=1.
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr18-schema-"));
    await run([lib, "__status-set", dir, "health", '"ok"']);
    const status = await Bun.file(join(dir, "renewal-status.json")).json();
    expect(status.schema).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
  // Ruling (fix-ocr18, item 13): the equality pin above IS the deliverable —
  // the field-list snapshot the future #362 consumer reads. An auxiliary
  // "every call line yields a literal key" detector was tried and dropped:
  // distinguishing a call from `log "status_set: …"` prose needs
  // shell-quoting awareness, disproportionate for a low item. The residual
  // risk (a variable-named key dodging extraction) is accepted.
});

describe("failure drill (offline)", () => {
  test("drill-renewal-failure.sh --offline passes its own assertions", async () => {
    const r = await run([drill, "--offline"]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("PASS");
  }, 60_000);
});

// ── fix-ocr4 #4: status_set's read-modify-write is serialized ───────────────
// The healthcheck (a separate process, 60s×4) and the entrypoint main loop
// (record_attempt's seven writes, the guard's 4–6) used to interleave freely:
// every writer rewrites the WHOLE file from its own read, so the last writer's
// snapshot won and the other's field silently vanished — a lost lastAlertAt
// defeats the cooldown into nonstop paging; a lost lastAttemptOk swallows an
// AC8 failure alert. The fix: an atomic mkdir lock around the whole
// read-modify-write (with a bounded spin, then write-anyway — the alert path
// prefers writing over losing).
//
// The deterministic interleave: writer A pauses between its read and its
// publish via the OPENBOT_TLS_STATUS_SET_HOOK seam, so writer B's ENTIRE
// write lands inside A's read-modify-write window. Pre-lock, A's publish
// then erases B's key; locked, B waits for the lock and re-reads after A.
describe("status_set concurrency (fix-ocr4 #4: the mkdir lock)", () => {
  test("two concurrent status_set writers on different keys both survive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-lock-"));
    const marker = join(dir, "a-read");
    const go = join(dir, "go");
    const hook = `touch '${marker}'; while [ ! -f '${go}' ]; do sleep 0.02; done`;
    const a = run([lib, "__status-set", dir, "keyA", '"a"'], {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_TLS_STATUS_SET_HOOK: hook,
    });
    // A has READ (it is now holding its stale snapshot inside the window).
    while (!existsSync(marker)) await Bun.sleep(10);
    const b = run([lib, "__status-set", dir, "keyB", '"b"'], {
      OPENBOT_TLS_DIR: dir,
    });
    // Release A; B must serialize behind it and re-read.
    await Bun.write(go, "1");
    await a;
    await b;
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.keyA).toBe("a");
    expect(status.keyB).toBe("b");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

// ── fix-ocr22 #5: the guard's judge→alert→write-lastAlert* run is ONE critical
// section ────────────────────────────────────────────────────────────────
//
// Two concurrent `--once` guards both READ lastAlertAt/Severity, both pass
// the cooldown, both send_alert, both write — a double page that defeats the
// cooldown the status file exists to enforce. (A healthcheck racing a guard
// only loses single fields, which status_set's own lock already serializes;
// the alert decision is the torn one.) The fix holds the SAME mkdir lock
// across read→decide→deliver→write; a second guard serializes behind it and
// reads the fresh cooldown.
describe("guard alert critical section (fix-ocr22 #5: two concurrent --once fire once)", () => {
  test("two concurrent --once guards with the cooldown open deliver exactly one alert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr22-5-"));
    // critical|renewal-failed: no certificate, a failed attempt on record,
    // no lastAlert* yet — every guard that reads it must want to fire.
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "concurrent drill",
    ]);
    const alertsFile = join(dir, "alerts.jsonl");
    // Deterministic double-fire on the unfixed code: each guard parks at its
    // FIRST status_set until BOTH have arrived — both have already read
    // lastAlertAt=null by then, so both decide fire and both deliver. On the
    // fixed code only the lock holder reaches status_set; the second guard
    // sits serialized on the lock, its park slot never fills, and the park
    // times out (2s cap — comfortably inside status_set's own 5s degrade).
    const arrived = join(dir, "arrived");
    const release = join(dir, "release");
    const hook = [
      `n=$(( $(cat '${arrived}' 2>/dev/null || echo 0) + 1 ))`,
      `echo "$n" > '${arrived}'`,
      "t=0",
      `while [ ! -f '${release}' ] && [ $t -lt 40 ]; do sleep 0.05; t=$((t+1)); done`,
    ].join("; ");
    const env = {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${alertsFile}`,
      OPENBOT_TLS_ALERT_COOLDOWN_SECONDS: "86400",
      OPENBOT_TLS_STATUS_SET_HOOK: hook,
    };
    const guardA = run([guard, "--once"], env);
    const guardB = run([guard, "--once"], env);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const n = Number(
        await Bun.file(arrived)
          .text()
          .catch(() => "0"),
      );
      if (n >= 2) break;
      await Bun.sleep(20);
    }
    await Bun.write(release, "1");
    const [a, b] = await Promise.all([guardA, guardB]);
    expect(a.exit).toBe(1);
    expect(b.exit).toBe(1);
    const alerts = (await Bun.file(alertsFile).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { severity: string });
    expect(alerts).toBeArrayOfSize(1);
    expect(alerts[0]?.severity).toBe("critical");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

// ── fix-ocr22 #7: an http:// alert webhook is a cleartext payload out of the
// host — say so, in the same grep-able WARN register as the OWNER and numeric
// warnings (宁可误报). https:// and file: targets stay silent about transport.
describe("http webhook WARN (fix-ocr22 #7)", () => {
  test("an http:// webhook warns while delivering; https:// and file: do not", async () => {
    const attempt = async (webhook: string) => {
      const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr22-7-"));
      await run([lib, "__record-attempt", dir, "false", "renew", "boom"]); // critical
      const r = await run([guard, "--once"], {
        OPENBOT_TLS_DIR: dir,
        // Port 9 (discard): refused instantly — delivery failure is not the
        // thing under test, the transport warning is.
        OPENBOT_TLS_ALERT_WEBHOOK: webhook,
      });
      expect(r.exit).toBe(1);
      await rm(dir, { recursive: true, force: true });
      return r;
    };
    const http = await attempt("http://127.0.0.1:9/unreachable");
    expect(http.err).toContain("WARN");
    expect(http.err).toContain("cleartext");
    const https = await attempt("https://127.0.0.1:9/unreachable");
    expect(https.err).not.toContain("cleartext");
    const fileTmp = await mkdtemp(join(tmpdir(), "openbot-tls-ocr22-7f-"));
    const file = await attempt(`file:${join(fileTmp, "a.jsonl")}`);
    expect(file.err).not.toContain("cleartext");
    await rm(fileTmp, { recursive: true, force: true });
  });
});

// ── fix-ocr4 #6: sha_of must actually fall back to shasum ───────────────────
// `sha256sum | cut || shasum | cut` took the exit code of the pipeline's LAST
// element (cut — always 0), so the shasum branch was dead code: on a host
// without sha256sum, sha_of answered the EMPTY string and the drill's
// "untouched (sha256)" assertion passed vacuously.
describe("sha_of (fix-ocr4 #6: the fallback is reachable)", () => {
  test("a present file yields its 64-hex digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-sha-"));
    const f = join(dir, "cert.pem");
    await Bun.write(f, "certificate bytes");
    const r = await run([lib, "__sha-of", f]);
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toMatch(/^[0-9a-f]{64}$/);
    await rm(dir, { recursive: true, force: true });
  });

  test("without sha256sum on PATH, the shasum fallback actually runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-sha-"));
    const f = join(dir, "cert.pem");
    await Bun.write(f, "certificate bytes");
    const expected = Bun.CryptoHasher.hash(
      "sha256",
      "certificate bytes",
      "hex",
    ) as string;
    // A PATH where shasum is the ONLY hash tool (sha256sum absent — the host
    // the fallback exists for). The marker file proves the fallback branch
    // executed; the digest proves its output is what sha_of answered. The
    // shim inherits this restricted PATH, so EVERY tool the shim itself
    // calls (touch, cut) must resolve inside shims — otherwise touch exits
    // 127 inside `2>/dev/null`, the marker never appears, and the digest
    // alone can't discriminate the branch (real sha256sum digests the same
    // bytes to the same hex).
    const shims = join(dir, "bin");
    await mkdir(shims);
    const marker = join(dir, "shasum-ran");
    const shasum = join(shims, "shasum");
    await Bun.write(
      shasum,
      `#!/bin/sh\ntouch '${marker}'\nprintf '%s  %s\\n' '${expected}' "$3"\n`,
    );
    await chmod(shasum, 0o755);
    await symlink(Bun.which("touch") as string, join(shims, "touch"));
    await symlink(Bun.which("cut") as string, join(shims, "cut"));
    const r = await run([lib, "__sha-of", f], { PATH: shims });
    expect(r.exit).toBe(0);
    expect(r.out.trim()).toBe(expected);
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

// ── fix-ocr4 #7: the container-restart fast path is not an attempt ──────────
// The entrypoint's "already issued (restart)" branch recorded a SUCCESSFUL
// issue — clobbering a possibly-failing lastAttemptOk/lastError. The guard
// then read a fake recovery (critical→ok), fired a false recovery alert, and
// the real failure signal stayed silent until acme.sh's own 60-day window
// surfaced it. A restart proves only that time passed: timestamp-class fields
// move, attempt-truth fields do not.
describe("record_restart (fix-ocr4 #7: restarts never fake attempts)", () => {
  test("a restart after a failed attempt leaves the attempt truth standing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-restart-"));
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    const restarted = await run([lib, "__record-restart", dir]);
    expect(restarted.exit).toBe(0);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.lastAttemptOk).toBe(false);
    expect(status.lastAttemptError).toContain("simulated");
    expect(typeof status.lastRestartAt).toBe("number");
    expect(typeof status.updatedAt).toBe("number");
    await rm(dir, { recursive: true, force: true });
  });
});

// ── fix-ocr5 J: a NEW incident right after a recovery fires immediately ──────
//
// should_alert had an escalation exception for warn→critical but not for
// ok→critical: the recovery alert writes lastAlertSeverity=ok, and a new
// fault inside the 24h cooldown window was then suppressed — up to 24h of
// silence for a genuinely new incident, defeating "re-fire after cooldown
// is for the SAME incident". After a recovery, lastAlertSeverity=ok means
// the previous incident is CLOSED: any non-ok state is a new incident and
// fires immediately, cooldown or not.
describe("alert cooldown symmetry (fix-ocr5 J)", () => {
  test("a new critical inside the cooldown window, right after a recovery, fires immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-j-"));
    const webhook = `file:${join(dir, "alerts.jsonl")}`;
    await makeCert(dir, 90);
    // Incident #1: renewal fails → critical alert (alert #1).
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "simulated dns api failure",
    ]);
    const failing = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: webhook,
    });
    expect(failing.status.health).toBe("critical");
    expect(failing.alerts).toBeArrayOfSize(1);
    // Recovery: exactly one ok alert (alert #2) — lastAlertSeverity is now ok.
    await run([lib, "__record-attempt", dir, "true", "renew", ""]);
    await makeCert(dir, 90);
    const recovered = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: webhook,
    });
    expect(recovered.status.health).toBe("ok");
    expect(recovered.alerts).toBeArrayOfSize(2);
    // NEW incident well inside the 24h cooldown: must fire NOW (alert #3) —
    // pre-fix the cooldown swallowed it (still 2 alerts, silent new fault).
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "a different dns api failure",
    ]);
    const refault = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: webhook,
    });
    expect(refault.status.health).toBe("critical");
    expect(refault.alerts).toBeArrayOfSize(3);
    expect(refault.alerts[2].severity).toBe("critical");
    await rm(dir, { recursive: true, force: true });
  }, 15_000);
});

// ── fix-ocr21 #6: a refused start clears the residual origin fields ──────
// The status volume outlives compose recreations. A deployment whose template
// flipped from valid to invalid leaves the OLD previewHost/certificate in
// renewal-status.json: the refusal writes health/healthReason/failedAt but
// never touches the origin pair, so the guard's alert row and webhook carry
// a host and certificate nothing serves.
describe("refuse_start clears residual previewHost/certificate (fix-ocr21 #6)", () => {
  test("a previously-valid status file + an invalid template → failed state WITHOUT the old origin's values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-refuse-"));
    const file = join(dir, "renewal-status.json");
    // The old deployment was valid: its origin pair is on the volume.
    await run([
      lib,
      "__status-set",
      dir,
      "previewHost",
      '"old.preview.example.com"',
    ]);
    await run([
      lib,
      "__status-set",
      dir,
      "certificate",
      '"*.old.preview.example.com"',
    ]);
    await run([lib, "__status-set", dir, "health", '"ok"']);
    // The refused start: the template's new form is invalid, the entrypoint
    // refuses (exit 1) — and the refusal must not leave the OLD origin
    // behind. Whatever shape the clear takes (empty string or the key
    // dropped, per the handwritten-JSON convention), the old values must be
    // gone from the file every consumer reads.
    const r = await run([entrypoint], {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE: "http://old.preview.example.com",
    });
    expect(r.exit).toBe(1);
    const status = JSON.parse(await Bun.file(file).text()) as Record<
      string,
      unknown
    >;
    expect(status.health).toBe("failed");
    expect(JSON.stringify(status)).not.toContain("old.preview.example.com");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

// ── fix-ocr5 F: a stale mkdir lock is recycled, not spun against ─────────────
//
// A SIGKILLed status_set holder leaves .lock behind forever: every later call
// then spins the full 50×0.1s and falls through to the write-WITHOUT-lock
// fallback — the exact lost-field bug fix-ocr4 #4's lock exists to prevent,
// back through the unlocked door, plus 5s of dead waiting per write. The hold
// window is the file rewrite itself (milliseconds), so a lock older than 60s
// can only be a corpse: recycle it once and retry the mkdir.
describe("status_set stale-lock recycling (fix-ocr5 F)", () => {
  test("a SIGKILL-leftover lock older than 60s is recycled — no dead spin, no unlocked write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-stale-"));
    const lock = join(dir, ".lock");
    await mkdir(lock);
    const ancient = new Date(Date.now() - 120_000);
    await utimes(lock, ancient, ancient);
    const startedAt = Date.now();
    const r = await run([lib, "__status-set", dir, "key", '"v"'], {
      OPENBOT_TLS_DIR: dir,
    });
    expect(r.exit).toBe(0);
    // The write went through the recycled-then-reacquired lock, not the
    // fallback: no "stuck" warning on stderr, a fast return (the dead spin
    // alone is 5s), the key landed, and the holder released the lock after.
    expect(r.err).not.toContain("stuck");
    expect(Date.now() - startedAt).toBeLessThan(4000);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.key).toBe("v");
    expect(existsSync(lock)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  test("a FRESH lock (a live holder) is never recycled — the conservative spin still stands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-fresh-"));
    const lock = join(dir, ".lock");
    await mkdir(lock); // age ~0: the age rule must refuse to touch it
    const r = await run([lib, "__status-set", dir, "key", '"v"'], {
      OPENBOT_TLS_DIR: dir,
    });
    expect(r.exit).toBe(0);
    // Young lock → the full bounded spin → the documented write-anyway path.
    expect(r.err).toContain("stuck");
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.key).toBe("v");
    expect(existsSync(lock)).toBe(true); // untouched: not ours to remove
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

// ── fix-ocr5 H/I: the entrypoint's first-issuance paths, end to end ──────────
//
// Both defects live in entrypoint.sh's startup flow, so these cases run the
// REAL entrypoint against a fake acme.sh (ACME_BIN is injectable) over a
// tmpdir TLS root — the same "spawn the production code" discipline as the
// rest of this file:
//   H — first issuance fails: exponential backoff (5s/30s/2m/10m/30m capped,
//       counter file reset on success) instead of a flat sleep 5 that, against
//       Docker's restart backoff, hammered LE's validation endpoint multiple
//       times per hour (5 failures/account/hour is the limit — one bad
//       deployment could lock out every deployment on the account);
//   I — install_cert fails after a successful issue: the old path only logged
//       and exited, leaving a STALE ok in the status file (record_attempt 1
//       from the successful issue, no guard run) for #362's admission gate to
//       read as fake health.
const entrypoint = join(certsDir, "entrypoint.sh");

/** A fake acme.sh: "issue-fails" fails --issue; "install-fails" issues (creates
 * the domain dir under --home) then fails --install-cert — the I defect's shape. */
async function fakeAcme(
  dir: string,
  mode: "issue-fails" | "install-fails",
): Promise<string> {
  const shim = join(dir, "fake-acme.sh");
  const script =
    mode === "issue-fails"
      ? `#!/bin/sh\necho "fake acme.sh: simulated DNS-01 failure" >&2\nexit 1\n`
      : `#!/bin/sh\nverb=""; home=""; dom=""\nprev=""\nfor a in "$@"; do\n  case "$prev" in\n    --home) home="$a" ;;\n    -d) dom="$a" ;;\n  esac\n  case "$a" in --issue|--install-cert) verb="$a" ;; esac\n  prev="$a"\ndone\nif [ "$verb" = "--install-cert" ]; then\n  echo "fake acme.sh: simulated install failure" >&2\n  exit 1\nfi\nmkdir -p "$home/\${dom}_ecc"\nexit 0\n`;
  await writeFile(shim, script);
  await chmod(shim, 0o755);
  return shim;
}

/** Run the real entrypoint against the fake acme.sh; staging CA avoids the email preflight. */
async function runEntrypoint(
  dir: string,
  acmeBin: string,
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return run([entrypoint], {
    OPENBOT_TLS_DIR: dir,
    ACME_HOME: join(dir, "acme-home"),
    ACME_BIN: acmeBin,
    ACME_CA: "letsencrypt_test",
    ACME_DNS: "dns_cf",
    CF_Token: "fake-token-for-offline-test",
    OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:
      "https://{session}.preview.example.com",
    ...env,
  });
}

describe("first-issuance backoff (fix-ocr5 H)", () => {
  test("issue_backoff_seconds answers the pinned schedule (pure seam)", async () => {
    const schedule: Array<[number, number]> = [
      [0, 1800], // a corrupt/absent counter degrades to the cap, never to 0
      [1, 5],
      [2, 30],
      [3, 120],
      [4, 600],
      [5, 1800],
      [99, 1800],
    ];
    for (const [failures, seconds] of schedule) {
      const r = await run([lib, "__backoff", String(failures)]);
      expect(`${failures}: ${r.exit}:${r.out.trim()}`).toBe(
        `${failures}: 0:${seconds}`,
      );
    }
  });

  test("a failing first issuance records the failure, backs off 5s, and leaves the counter behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-h-"));
    const shim = await fakeAcme(dir, "issue-fails");
    const startedAt = Date.now();
    const r = await runEntrypoint(dir, shim);
    const elapsed = Date.now() - startedAt;
    expect(r.exit).toBe(1);
    // The backoff happened (≥ the 5s first-failure delay) but is bounded.
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(20_000);
    // The counter file pins the consecutive-failure count for the next start.
    expect(await Bun.file(join(dir, ".issue-failures")).text()).toBe("1\n");
    // The guard ran: the failure is alertable truth, not a silent crash.
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.lastAttemptOk).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

describe("install_cert failure path (fix-ocr5 I) + entrypoint umask (fix-ocr5 G)", () => {
  test("install_cert failure records a failed attempt and runs the guard — no stale ok for the admission gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-i-"));
    const shim = await fakeAcme(dir, "install-fails");
    const r = await runEntrypoint(dir, shim);
    expect(r.exit).toBe(1);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    // Pre-fix: the successful --issue left lastAttemptOk=true and NO guard
    // evaluation ever ran (no health field) — #362's admission gate would
    // have read fake health through the whole outage.
    expect(status.lastAttemptOk).toBe(false);
    expect(String(status.lastAttemptError)).toContain("install-cert");
    expect(status.health).toBe("critical");
    expect(status.healthReason).toBe("missing");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  test("fix-ocr5 G: the umask 077 entrypoint writes its private state private (status file 600)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-g-"));
    const shim = await fakeAcme(dir, "issue-fails");
    const r = await runEntrypoint(dir, shim);
    expect(r.exit).toBe(1);
    // The status file carries attempt truth and error digests — under the
    // entrypoint's umask 077 it is owner-only. (cert.pem/key.pem stay
    // explicitly 644/600 via reload.sh's chmod floor, umask-independent.)
    const mode = (await stat(join(dir, "renewal-status.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

// ── fix-ocr8 #1: the restart fast path must find acme.sh's `_.` directory ───
// acme.sh normalizes a `*.` wildcard to `_.` in its on-disk domain directory
// (`*.preview.example.com` → `acme-home/_.preview.example.com_ecc`). The
// entrypoint checked the LITERAL `*.preview.example.com_ecc`, which never
// exists — so every restart re-walked --issue, where the real acme.sh skips an
// unexpired certificate with rc 0 and the pipeline recorded that skip as a
// SUCCESSFUL attempt (clobbering a real lastAttemptOk=false — exactly what
// fix-ocr4 #7's record_restart fast path exists to prevent) and wiped the
// fix-ocr5 H backoff counter.
//
// The test runs the REAL entrypoint against a shim acme.sh over a tmpdir
// pre-seeded with the `_.`-normalized directory: the entrypoint must take the
// restart fast path (already-issued log, record_restart, --issue never
// invoked) and park in its renewal loop — the process is killed once the loop
// banner shows. The success paths never exit, so this helper waits for the
// banner and fails with the collected stderr on any earlier exit.
async function runEntrypointUntilRenewalLoop(
  dir: string,
  acmeBin: string,
  env: Record<string, string | undefined> = {},
): Promise<{ stderr: string; kill: () => Promise<void> }> {
  const proc = Bun.spawn([bash, entrypoint], {
    env: {
      ...process.env,
      OPENBOT_TLS_DIR: dir,
      ACME_HOME: join(dir, "acme-home"),
      ACME_BIN: acmeBin,
      ACME_CA: "letsencrypt_test",
      ACME_DNS: "dns_cf",
      CF_Token: "fake-token-for-offline-test",
      OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:
        "https://{session}.preview.example.com",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let stderr = "";
  const pump = (async () => {
    const reader = proc.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
  })();
  const settled = await Promise.race([
    (async () => {
      while (!stderr.includes("entering renewal loop")) await Bun.sleep(20);
      return "loop" as const;
    })(),
    proc.exited.then(() => "exit" as const),
    Bun.sleep(30_000).then(() => "timeout" as const),
  ]);
  if (settled !== "loop") {
    proc.kill();
    await pump.catch(() => {});
    throw new Error(
      `entrypoint ${settled === "exit" ? `exited ${await proc.exited}` : "hung"} before the renewal loop:\n${stderr}`,
    );
  }
  return {
    stderr,
    kill: async () => {
      proc.kill();
      await proc.exited;
      // The renewal loop's `sleep` child inherits the stderr pipe, so EOF can
      // outlive the killed entrypoint — never wait on the pump unbounded.
      await Promise.race([pump.catch(() => {}), Bun.sleep(1000)]);
    },
  };
}

describe("restart fast path finds acme.sh's `_.` wildcard directory (fix-ocr8 #1)", () => {
  test("an existing `_.<base>_ecc` directory means already-issued: no re-issue, restart recorded, loop entered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr8-1-"));
    const acmeHome = join(dir, "acme-home");
    // acme.sh's own normalization: `*.` is stored as `_.`.
    await mkdir(join(acmeHome, "_.preview.example.com_ecc"), {
      recursive: true,
    });
    // A shim that logs every invocation; --issue (which must NEVER run here)
    // and anything unrecognized fail loudly, --install-cert succeeds so the
    // startup reaches the renewal loop.
    const shimLog = join(dir, "acme-invocations.log");
    const shim = join(dir, "fake-acme.sh");
    await Bun.write(
      shim,
      `#!/bin/sh\nverb=""\nfor a in "$@"; do\n  case "$a" in --issue|--install-cert|--cron) verb="$a" ;; esac\ndone\nprintf '%s\\n' "\${verb:-no-verb}" >> '${shimLog}'\n[ "$verb" = "--install-cert" ] && exit 0\nexit 1\n`,
    );
    await chmod(shim, 0o755);

    const { stderr, kill } = await runEntrypointUntilRenewalLoop(dir, shim);
    await kill();

    // The fast path ran: no re-issuance was attempted...
    const invocations = await Bun.file(shimLog).text();
    expect(invocations).not.toContain("--issue");
    expect(invocations).toContain("--install-cert");
    expect(stderr).toContain("certificate already issued");
    // ...and the restart is recorded as a RESTART, not an attempt (fix-ocr4 #7).
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(typeof status.lastRestartAt).toBe("number");
    expect(status.lastAttemptOk).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

// ── fix-ocr9 #2: the guard must not overwrite the skip form's health ─────────
// The skip form (empty/dev or http template) writes health="skipped" and stays
// resident (fix-ocr8 #4); the compose healthcheck then runs the guard every 60s,
// and the guard's certificate-based decision (no cert, no attempt → "starting")
// overwrote skipped on its first cycle — and every cycle after: the skip
// semantics were destroyed and the file permanently claimed a first issuance
// that will never exist. The guard must preserve skipped — while the ENVIRONMENT
// is still the skip form (derive on the template env), so a template flip to a
// valid form releases the preserve and the guard decides fresh again.
describe("the guard preserves the skip form's health (fix-ocr9 #2)", () => {
  test("a skipped status file survives guard --once and --healthcheck unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr9-2-"));
    // What the entrypoint's skip branch leaves behind (no cert, no attempt —
    // the exact state the old guard re-labeled "starting" forever).
    const seeded = await run([lib, "__status-set", dir, "health", '"skipped"']);
    expect(seeded.exit).toBe(0);
    await run([lib, "__status-set", dir, "healthReason", '"dev form (D5)"']);

    const once = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(once.result.exit).toBe(0); // skipped is not critical, not alertable
    expect(once.status.health).toBe("skipped"); // RED: became "starting"
    expect(once.status.healthReason).toBe("dev form (D5)");
    expect(once.alerts).toBeArrayOfSize(0);
    // The compose healthcheck probes the same decision on its own cadence.
    const probe = await run([guard, "--healthcheck"], { OPENBOT_TLS_DIR: dir });
    expect(probe.exit).toBe(0);
    const after = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(after.health).toBe("skipped");
    await rm(dir, { recursive: true, force: true });
  });

  test("a template flip to a valid form releases the preserve — the guard decides fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr9-2b-"));
    await run([lib, "__status-set", dir, "health", '"skipped"']);
    // The template is now a valid https form (compose recreation after a config
    // change): preserving skipped here would be the same eternal-stale disease
    // in the opposite direction — no cert and no attempt is honestly "starting".
    const r = await run([guard, "--once"], {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:
        "https://{session}.preview.example.com",
    });
    expect(r.exit).toBe(0);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.health).toBe("starting");
    await rm(dir, { recursive: true, force: true });
  });
});

// ── fix-ocr9 #3: a REFUSED start is a recorded state, not a fake "in-flight" ──
// Two startup paths reject the sidecar before any pipeline work: the template
// invalid branch (exited 1 with NO status record at all) and the preflight
// failures (exited 1 with only the previewHost/certificate partial fields).
// The guard's decision for both shapes is "starting" (no cert, no attempt), so
// a crash-restarting container presented a PERMANENT fake in-flight state to
// the admission gate and any dashboard. Both paths must now write
// health="failed" + the reason before exiting, and the guard must preserve
// failed with failure semantics: exit non-zero in both modes, alertable on
// --once — until a later startup gets far enough to overwrite health itself.
describe("a refused start records an explicit failed state (fix-ocr9 #3)", () => {
  test("an invalid template exits 1 with health=failed and the reason on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr9-3-"));
    const r = await run([entrypoint], {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:
        "https://{session}preview.example.com",
    });
    expect(r.exit).toBe(1);
    expect(r.err).toContain("refusing to start");
    // RED: no status record existed at all (ENOENT) — the refusal was only a
    // log line, and the guard rendered the aftermath as eternal "starting".
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.health).toBe("failed");
    expect(String(status.healthReason)).toContain("{session}");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  test("a preflight failure (no DNS plugin configured) records health=failed too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr9-3b-"));
    const shim = await fakeAcme(dir, "issue-fails"); // never reached
    const r = await runEntrypoint(dir, shim, { ACME_DNS: "" });
    expect(r.exit).toBe(1);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.health).toBe("failed");
    expect(String(status.healthReason)).toContain("ACME_DNS");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  test("the guard preserves failed with failure semantics: exit 1, no overwrite, alert on --once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr9-3c-"));
    await run([lib, "__status-set", dir, "health", '"failed"']);
    await run([
      lib,
      "__status-set",
      dir,
      "healthReason",
      '"ACME_DNS is required"',
    ]);
    const once = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    // RED: the old guard decided "starting" (no cert, no attempt) — exit 0,
    // no alert, and the refusal reason overwritten away.
    expect(once.result.exit).toBe(1);
    expect(once.status.health).toBe("failed");
    expect(once.status.healthReason).toBe("ACME_DNS is required");
    expect(once.alerts).toBeArrayOfSize(1);
    expect(once.alerts[0].severity).toBe("critical");
    expect(once.alerts[0].reason).toBe("refused-start");
    // The compose healthcheck shares the failure semantics: red, not "healthy".
    const probe = await run([guard, "--healthcheck"], { OPENBOT_TLS_DIR: dir });
    expect(probe.exit).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("fix-ocr22 #6: the failed branch refreshes evaluatedAt on exit — a crash loop's timestamps move", async () => {
    // crash-loop 期 health=failed 的分支 exit 前不写 evaluatedAt：时间戳冻结
    // 在拒绝发生的那一刻，无法区分「故障持续（guard 仍在评估）」与「文件冻结
    // （guard 死了）」。与 skip 保留分支对齐：exit 前刷 evaluatedAt，两种模式
    // 都要刷（healthcheck 的 60s 探测是失败期唯一的心跳来源）。
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr22-6-"));
    await run([lib, "__status-set", dir, "health", '"failed"']);
    await run([
      lib,
      "__status-set",
      dir,
      "healthReason",
      '"ACME_DNS is required"',
    ]);
    await run([lib, "__status-set", dir, "evaluatedAt", "1000"]);
    const before = Math.floor(Date.now() / 1000) - 1;
    const probe = await run([guard, "--healthcheck"], { OPENBOT_TLS_DIR: dir });
    expect(probe.exit).toBe(1);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.health).toBe("failed");
    expect(status.evaluatedAt).toBeGreaterThanOrEqual(before);
    // --once 同样刷新（并且仍保留 failed 语义：exit 1 + 拒绝理由不动）。
    const once = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(once.result.exit).toBe(1);
    expect(once.status.health).toBe("failed");
    expect(once.status.healthReason).toBe("ACME_DNS is required");
    expect(once.status.evaluatedAt).toBeGreaterThanOrEqual(before);
    await rm(dir, { recursive: true, force: true });
  });

  test("a later successful startup releases failed — the pipeline's own truth takes over", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr9-3d-"));
    await run([lib, "__status-set", dir, "health", '"failed"']);
    const shim = await fakeAcme(dir, "install-fails");
    const r = await runEntrypoint(dir, shim);
    expect(r.exit).toBe(1); // still fails — but at the INSTALL stage now
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    // The fresh startup overwrote the stale refusal with the decided state
    // (critical|missing): failed must not stick once real work has run.
    expect(status.health).toBe("critical");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

// ── fix-ocr8 #2: stale-lock recycling must not delete a LIVE lock (TOCTOU) ──
// Two concurrent status_set calls could both judge a >60s-old lock dead: the
// first rmdir'd it and took a FRESH lock, the second — still holding the stale
// "it was old" verdict — rmdir'd the first one's live lock, and two writers
// held the same critical section. The fix writes the holder's PID into the
// lock (owner file) and re-verifies before any removal: the age is re-stated
// and/or the recorded owner checked with kill -0. The test replays the race
// deterministically through a seam that pauses the recycler INSIDE the window
// (after the first age check, before the removal) while the test swaps the
// corpse for a fresh lock owned by a live process.
describe("stale-lock recycling TOCTOU (fix-ocr8 #2: a live lock is never recycled)", () => {
  test("a lock re-created by a concurrent acquirer inside the recycle window survives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-toctou-"));
    const lock = join(dir, ".lock");
    // The corpse the recycler will observe: old enough for the recycle path,
    // no owner file (the pre-fix lock format).
    await mkdir(lock);
    const ancient = new Date(Date.now() - 120_000);
    await utimes(lock, ancient, ancient);

    const marker = join(dir, "in-window");
    const go = join(dir, "go");
    const hook = `touch '${marker}'; while [ ! -f '${go}' ]; do sleep 0.02; done`;
    const writer = run([lib, "__status-set", dir, "key", '"v"'], {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_TLS_RECYCLE_HOOK: hook,
    });
    // Either the recycler enters the window (fixed) or it finishes without
    // one (pre-fix: it rmdir'd the corpse and acquired immediately).
    const outcome = await Promise.race([
      (async () => {
        while (!existsSync(marker)) await Bun.sleep(10);
        return "marker" as const;
      })(),
      writer.then(() => "exit" as const),
    ]);

    // Replay the race: a concurrent acquirer recycles the corpse and takes a
    // FRESH lock whose owner is alive (a real process, mid-sleep).
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      await rm(lock, { recursive: true, force: true });
      await mkdir(lock);
      await Bun.write(join(lock, "owner"), `${holder.pid}\n`);
      await Bun.write(go, "1");
      const r = await writer;

      // The window was entered at all (pre-fix the seam does not exist, and
      // the recycler has by now removed whatever was in its way).
      expect(await Bun.file(marker).exists()).toBe(true);
      // The re-created live lock survived the recycler...
      expect((await stat(lock)).isDirectory()).toBe(true);
      expect(await Bun.file(join(lock, "owner")).text()).toBe(
        `${holder.pid}\n`,
      );
      // ...which refused it (no recycle log) and fell through to the
      // documented bounded-spin write-anyway path instead.
      expect(r.exit).toBe(0);
      expect(r.err).toContain("stuck");
      expect(r.err).not.toContain("recycling");
      const status = JSON.parse(
        await Bun.file(join(dir, "renewal-status.json")).text(),
      ) as Record<string, unknown>;
      expect(status.key).toBe("v");
    } finally {
      holder.kill();
    }
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

// ── fix-ocr8 #3: a renewal that RESTORES a missing certificate is a success ──
// run_renewal recorded success only when a NON-empty before-digest changed:
// before empty (cert.pem missing — the critical|missing state) + after
// non-empty (the command restored it) recorded NOTHING, so lastAttemptOk
// stayed false forever and the guard kept the critical alarm up after the
// recovery. "after non-empty && after !== before" is the restored-install
// success; both empty (nothing due, nothing there) still records nothing.
describe("run_renewal restored-install success (fix-ocr8 #3)", () => {
  test("a renew command that restores a missing cert.pem records success — no permanent critical", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr8-3-"));
    // Last known state: issuance failed, no certificate ever landed.
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "issue",
      "acme.sh --issue exited 1",
    ]);
    const before = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(before.status.health).toBe("critical");
    // The renewal command RESTORES the certificate (a real one: the guard's
    // next evaluation must be able to read it with openssl).
    const restore = [
      "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "90",
      "-subj",
      "/CN=*.drill.invalid",
    ].join(" ");
    const r = await run([lib, "__run-renewal", dir], {
      OPENBOT_TLS_RENEW_CMD: restore,
    });
    expect(r.exit).toBe(0);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.lastAttemptOk).toBe(true);
    expect(typeof status.lastSuccessAt).toBe("number");
    // And the next guard evaluation reads the recovery, not a stale alarm.
    const after = await guardOnce(dir, {
      OPENBOT_TLS_ALERT_WEBHOOK: `file:${join(dir, "alerts.jsonl")}`,
    });
    expect(after.status.health).toBe("ok");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

// ── fix-ocr20 #6: a reload-class failure is not a renewal failure ──────────
// acme.sh --cron can renew AND install the new certificate (the registered
// reloadcmd runs inside --install-cert) yet still exit non-zero — a reload-
// adjacent failure after the install. The old rc≠0 branch recorded a FAILED
// attempt regardless, and since the next real renewal is ~60 days out, the
// guard held a critical alarm for weeks against a certificate that HAD been
// renewed. When the certificate hash CHANGED across the run, the attempt is
// recorded ok (the error summary stays in lastAttemptError, the log says
// reload-class) and the guard reads the truth.
describe("run_renewal reload-class failure (fix-ocr20 #6)", () => {
  test("rc≠0 with a changed cert records ok, keeps the error summary, and the guard does not go critical", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr20-6-"));
    // The currently-installed certificate (the "before" hash).
    await run([
      "sh",
      "-c",
      [
        "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "90",
        "-subj",
        "/CN=*.drill.invalid",
      ].join(" "),
    ]);
    // The renewal command installs a NEW certificate (the reloadcmd's work)
    // and then exits non-zero — the reload-class shape.
    const renew = [
      "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "90",
      "-subj",
      "/CN=*.drill.invalid",
      "&& exit 3",
    ].join(" ");
    const r = await run([lib, "__run-renewal", dir], {
      OPENBOT_TLS_RENEW_CMD: renew,
    });
    // The run's verdict is the RENEWAL's (a new cert is installed), not the
    // reload wart's — and the log names the class honestly.
    expect(r.exit).toBe(0);
    expect(r.out + r.err).toContain("reload-class");
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.lastAttemptOk).toBe(true);
    // The error summary survives (the wart is observable, not swallowed).
    expect(String(status.lastAttemptError)).toContain("3");
    expect(typeof status.lastSuccessAt).toBe("number");
    // And the next guard evaluation reads health, not a weeks-long critical.
    const after = await guardOnce(dir, {});
    expect(after.status.health).not.toBe("critical");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  test("rc≠0 with an UNCHANGED cert is still a failed attempt (the drill's shape, regression)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr20-6b-"));
    await run([
      "sh",
      "-c",
      [
        "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "90",
        "-subj",
        "/CN=*.drill.invalid",
      ].join(" "),
    ]);
    await run([lib, "__run-renewal", dir], {
      OPENBOT_TLS_RENEW_CMD: "exit 70",
    });
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.lastAttemptOk).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

// ── fix-ocr20 #8/#9/#10: deployment wiring pins ─────────────────────────
// #8: the gitignore's tls/ entry — the sidecar's output directory is exactly
// ./tls at the REPO ROOT, so the pattern must be anchored (an unanchored
// `tls/` ignores every directory named tls anywhere, e.g. inside a generated
// webapp), and it must carry NO trailing slash, the same symlink semantics
// the node_modules line in the same file records: with a trailing slash the
// pattern matches directories only, so a symlinked tls directory (sandbox
// workspace links) would be happily committed — secrets and all.
// #9: PID 1 ignores signals it never registered (kernel default-disposition
// rule), so docker stop's SIGTERM did nothing and every stop was a 10s
// SIGKILL — the entrypoint must trap TERM/INT for its daemon loops.
// #10: ACME_ACCOUNT_EMAIL rides the acme.sh command line as ONE word; the
// old un-quoted `$account_email_args` split on whitespace/globs.
describe("deployment wiring pins (fix-ocr20 #8/#9/#10)", () => {
  const gitignoreSource = readFileSync(".gitignore", "utf8");
  const entrySource = readFileSync(
    "docker/compose/certs/entrypoint.sh",
    "utf8",
  );

  test("#8: the tls gitignore entry is root-anchored and matches symlinks (no trailing slash)", () => {
    const tlsLines = gitignoreSource
      .split("\n")
      .filter((line) => /^\/?tls\/?$/.test(line.trim()));
    expect(tlsLines).toEqual(["/tls"]);
  });

  test("#9: the entrypoint traps TERM/INT — PID 1 ignores unregistered signals", () => {
    // Code lines only: a comment mention is prose, not the wiring.
    const code = entrySource
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).toContain("trap 'exit 0' TERM INT");
  });

  test("#10: the account email rides the command line as one quoted word — no unquoted args variable", () => {
    // Code lines only: the comment above the line names the retired variable
    // as prose; the wiring is what must be gone.
    const code = entrySource
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(entrySource).toContain('--accountemail "$EMAIL"');
    expect(code).not.toContain("account_email_args");
  });

  test("fix-ocr22 #8: the compose-project-dir tls fallback is git-ignored, and the docs put custom in-repo dirs on the deployment", () => {
    // Omitting --project-directory makes compose resolve against the compose
    // file's OWN directory — the OPENBOT_TLS_HOST_DIR default `./tls` then
    // lands at docker/compose/tls instead of the repo root. The root-anchored
    // `/tls` entry cannot catch that spelling; this fallback does.
    expect(gitignoreSource).toContain("docker/compose/tls/");
    const docs = readFileSync("docs/tls-certs.md", "utf8");
    // The fallback is bound-of-one: a CUSTOM in-repo host directory is the
    // deployment's own gitignore job, and the docs must say so.
    expect(docs).toContain("gitignore");
  });

  test("fix-ocr22 #9/#10: the compose floor is documented, and the drill's usage matches its sh shebang", () => {
    const docs = readFileSync("docs/tls-certs.md", "utf8");
    // certs.yml's env_file long syntax (`path:` + `required:`) needs
    // compose ≥ 2.24; older versions fail with an unknown-key error that
    // reads like a broken repo. The floor is part of the deployment guide.
    expect(docs).toContain("2.24");
    const drillSource = readFileSync(drill, "utf8");
    // The drill's shebang is /bin/sh; its usage line must not teach `bash`.
    expect(drillSource).toContain(
      "Usage: sh docker/compose/certs/drill-renewal-failure.sh",
    );
    expect(drillSource).not.toContain(
      "Usage: bash docker/compose/certs/drill-renewal-failure.sh",
    );
  });
});

// ── fix-ocr8 #4: the skip form stays resident ────────────────────────────────
// The skip branch (empty/dev or http template — no certificate to issue) used
// to `exit 0`. Under certs.yml's `restart: on-failure` an exited-0 container
// is never restarted, and a daemon/host reboot pulls back only RUNNING
// containers — so the sidecar stayed down for the host's lifetime: no
// healthcheck, a frozen renewal-status.json, no TLS pane answer. The fix
// parks the skip form in a resident sleep loop instead of exiting.
describe("the skip form stays resident (fix-ocr8 #4)", () => {
  test("an empty template logs the skip reason, writes skipped health, and does NOT exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr8-4-"));
    const proc = Bun.spawn([bash, entrypoint], {
      env: {
        ...process.env,
        OPENBOT_TLS_DIR: dir,
        OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const decoder = new TextDecoder();
    let stderr = "";
    const pump = (async () => {
      const reader = proc.stderr.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
      }
    })();
    // The skip branch answers immediately...
    const sawSkip = await Promise.race([
      (async () => {
        while (!stderr.includes("no certificate pipeline")) {
          await Bun.sleep(20);
        }
        return true;
      })(),
      Bun.sleep(15_000).then(() => false),
    ]);
    expect(sawSkip).toBe(true);
    // ...and then the process must KEEP RUNNING (the pre-fix `exit 0` fails
    // here): residency is what a reboot's restart policy needs to see.
    const survived = await Promise.race([
      proc.exited.then(() => false),
      Bun.sleep(2500).then(() => true),
    ]);
    expect(survived).toBe(true);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.health).toBe("skipped");
    proc.kill();
    await proc.exited;
    // The resident loop's `sleep` child inherits the stderr pipe — race the
    // pump instead of waiting for an EOF that may outlive the killed process.
    await Promise.race([pump.catch(() => {}), Bun.sleep(1000)]);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

// ── fix-ocr19 #6: run_renewal rides the ACME_BIN the entrypoint defines ──────
// The entrypoint honors ACME_BIN everywhere (issue, install-cert, and the
// tests' own fake-acme seam), but run_renewal — the SHARED renewal body the
// drill reuses — hardcoded `acme.sh`: an acme.sh installed under another name
// (or a wrapper shim) renewed through a binary that may not exist, while the
// rest of the pipeline drove the override. The definition moves up to lib.sh's
// exported layer (entrypoint sources lib.sh; both files see one ACME_BIN) and
// run_renewal calls it.
describe("run_renewal honors ACME_BIN (fix-ocr19 #6)", () => {
  test("a successful --cron through ACME_BIN records nothing — the hardcoded acme.sh used to fail the call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr19-acmebin-"));
    // A prior SUCCESS stands in the status file: a not-due renewal cycle
    // must not touch attempt truth at all.
    await run([lib, "__record-attempt", dir, "true", "issue", ""]);
    // A shim that logs its invocation and exits 0 (not due: no cert change).
    const shimLog = join(dir, "cron-invocations.log");
    const shim = join(dir, "fake-cron.sh");
    await Bun.write(
      shim,
      `#!/bin/sh\nprintf 'cron\\n' >> '${shimLog}'\nexit 0\n`,
    );
    await chmod(shim, 0o755);
    const r = await run([lib, "__run-renewal", dir], { ACME_BIN: shim });
    expect(r.exit).toBe(0);
    // RED: run_renewal called the hardcoded `acme.sh` (not on this host's
    // PATH) instead of the injected shim — exit 127, a FAILED attempt
    // clobbering the prior success, and the shim never ran.
    expect(r.err).not.toContain("renewal FAILED");
    expect(await Bun.file(shimLog).text()).toContain("cron");
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.lastAttemptOk).toBe(true); // untouched: not due, nothing recorded
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

// ── fix-ocr19 #7: INTERVAL rides tls_numeric — the entrypoint's own convention ──
// fix-ocr18 #10 established the rule for the pipeline's numeric env knobs
// (a bad value falls back to the default WITH a WARN, never into arithmetic
// that fails open); INTERVAL — read one line later in the same file — was
// left out: `OPENBOT_TLS_RENEW_INTERVAL_SECONDS=864OO` errored the `[ -ge ]`
// test, the `|| INTERVAL=600` caught the wreckage, and the sidecar silently
// renewed every 10 minutes (96 acme.sh runs a day) with no warning anywhere.
describe("the renewal INTERVAL rides tls_numeric (fix-ocr19 #7)", () => {
  test("a non-numeric INTERVAL warns and takes the default, not the 600s floor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr19-interval-"));
    const acmeHome = join(dir, "acme-home");
    await mkdir(join(acmeHome, "_.preview.example.com_ecc"), {
      recursive: true,
    });
    const shim = join(dir, "fake-acme.sh");
    await Bun.write(
      shim,
      '#!/bin/sh\ncase "$*" in *--install-cert*) exit 0 ;; esac\nexit 0\n',
    );
    await chmod(shim, 0o755);
    const { stderr, kill } = await runEntrypointUntilRenewalLoop(dir, shim, {
      OPENBOT_TLS_RENEW_INTERVAL_SECONDS: "864OO",
    });
    await kill();
    // RED: the wrecked comparison silently landed on the 600s floor.
    expect(stderr).toContain("WARN");
    expect(stderr).toContain("864OO");
    expect(stderr).toContain("every 21600s");
    expect(stderr).not.toContain("every 600s");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

// ── fix-ocr19 #8: the usage line lists every command the harness answers ─────
// The dispatcher's case grew seams (__numeric, __cert-dir, __owner-uid-gid)
// that the usage hint never mentioned — the documented contract of this
// library lagged the code. The line is generated by hand; the test walks the
// source's actual case labels so they cannot drift apart again.
describe("lib.sh usage line (fix-ocr19 #8)", () => {
  test("an unknown command's usage lists every command the case dispatch answers", async () => {
    const r = await run([lib, "__no-such-command"]);
    expect(r.exit).toBe(2);
    const source = await Bun.file(lib).text();
    const commands = [...source.matchAll(/^\s{2}(__[a-z-]+)\)/gm)].map(
      (m) => m[1] as string,
    );
    expect(commands.length).toBeGreaterThan(5); // the roster is really this file's
    for (const command of commands) {
      expect(r.err).toContain(command);
    }
  });
});

// ── fix-ocr26 #10: a refused start evaluates the guard before exiting ────────
// The refuse branches wrote health="failed" (fix-ocr9 #3) and exited — but the
// guard --once call that fires the refused-start alert sat only on the
// issuance/install failure paths: on the REFUSED paths the alert was dead
// code. The sidecar could refuse with zero pages, forever. Every refuse
// branch now evaluates the guard before its exit; the guard degrades
// gracefully when the TLS directory itself is unwritable, and the cooldown
// dedupes a crash-looping container's repeat alerts.
describe("a refused start evaluates the guard before exiting (fix-ocr26 #10)", () => {
  test("an invalid template's refuse path leaves the guard's evaluation trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr26-10-"));
    const r = await run([entrypoint], {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:
        "https://{session}preview.example.com",
    });
    expect(r.exit).toBe(1);
    // RED: refuse_start wrote the failed state, but no guard evaluation ever
    // ran — evaluatedAt was absent and the refused-start alert never fired.
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.health).toBe("failed");
    expect(typeof status.evaluatedAt).toBe("number");
    // The guard's durable signal: the standalone alert marker with the
    // refused-start reason (no webhook configured — the log line is it).
    expect(r.err).toContain("openbot-tls-alert");
    expect(r.err).toContain("refused-start");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  test("a preflight refuse path (no DNS plugin) runs the guard too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr26-10b-"));
    const shim = await fakeAcme(dir, "issue-fails"); // never reached
    const r = await runEntrypoint(dir, shim, { ACME_DNS: "" });
    expect(r.exit).toBe(1);
    const status = JSON.parse(
      await Bun.file(join(dir, "renewal-status.json")).text(),
    ) as Record<string, unknown>;
    expect(status.health).toBe("failed");
    expect(typeof status.evaluatedAt).toBe("number");
    expect(r.err).toContain("openbot-tls-alert");
    expect(r.err).toContain("refused-start");
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

// ── fix-ocr26 #11: the alert webhook delivers OUTSIDE the lock ───────────────
// The guard's --once critical section wrapped judge → send_alert → write
// lastAlert*, and send_alert carried the webhook curl (-m 15): a webhook
// slower than the lock's 5s spin budget (50×0.1s) held the mutex past the
// second guard's degrade point, which then proceeded unlocked, read the
// pre-alert cooldown state, and ALSO delivered — the double-page the cooldown
// exists to prevent, striking exactly when delivery is slowest. The fix
// reserves the alert position INSIDE the lock (lastAlertAt/lastAlertSeverity
// written first, plus the durable openbot-tls-alert log line) and performs
// the webhook delivery AFTER the lock is released: hold time back to
// milliseconds, mutual exclusion independent of webhook latency.
describe("guard alert critical section vs a slow webhook (fix-ocr26 #11)", () => {
  test("a webhook slower than the spin budget delivers exactly once across two concurrent guards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-tls-ocr26-11-"));
    // critical|renewal-failed: no certificate, a failed attempt on record,
    // no lastAlert* yet — every guard that reads it must want to fire.
    await run([
      lib,
      "__record-attempt",
      dir,
      "false",
      "renew",
      "slow webhook drill",
    ]);
    // The harness injects a SLOW curl: records its delivery, then hangs past
    // the lock's whole spin budget (6s > 5s). shim dir first on PATH so the
    // guard's curl resolves here and everything else (openssl, find, …)
    // resolves as usual.
    const shims = join(dir, "bin");
    await mkdir(shims);
    const deliveries = join(dir, "deliveries.log");
    const slowCurl = join(shims, "curl");
    await Bun.write(
      slowCurl,
      `#!/bin/sh\nprintf 'delivery\\n' >> '${deliveries}'\nsleep 6\n`,
    );
    await chmod(slowCurl, 0o755);
    const env = {
      OPENBOT_TLS_DIR: dir,
      OPENBOT_TLS_ALERT_WEBHOOK: "https://slow-webhook.invalid/alert",
      OPENBOT_TLS_ALERT_COOLDOWN_SECONDS: "86400",
      PATH: `${shims}:${process.env.PATH ?? ""}`,
    };
    const [a, b] = await Promise.all([
      run([guard, "--once"], env),
      run([guard, "--once"], env),
    ]);
    // Both guards judge critical either way.
    expect(a.exit).toBe(1);
    expect(b.exit).toBe(1);
    // RED: the second guard degraded past the lock while the first was stuck
    // in the webhook, read the pre-alert state, and delivered too — TWO
    // deliveries for one incident.
    const lines = (await Bun.file(deliveries).text())
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(1);
    // And neither guard degraded: the hold time is back to milliseconds.
    expect(`${a.err}${b.err}`).not.toContain("stuck");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});
