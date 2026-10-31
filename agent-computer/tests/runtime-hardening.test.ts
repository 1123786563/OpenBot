import { describe, expect, test } from "../../tests/support/e2e-compat";
import { offeredToken } from "../src/authorisation";
import { createControl } from "../src/control";

const SECRET = "a-long-development-secret";
const url = (path: string) => new URL(`http://computer.test${path}`);

/**
 * The header path trimmed while `/stream` did not, so `?token=%20SECRET` 401d while the same
 * value in a header succeeded. `Bearer   SECRET  ` left leading spaces behind the regex.
 */
describe("offered token trimming", () => {
  test("trims a padded stream query token", () => {
    const headers = new Headers();
    expect(
      offeredToken(
        headers,
        url(`/stream?token=${encodeURIComponent(`  ${SECRET}  `)}`),
      ),
    ).toBe(SECRET);
  });

  test("trims the bearer remainder", () => {
    const headers = new Headers({ authorization: `Bearer   ${SECRET}  ` });
    expect(offeredToken(headers, url("/snapshot"))).toBe(SECRET);
  });
});

/**
 * `reason` and `label` are stored and polled ~1Hz by every viewer for the request TTL. A
 * model-generated megabyte string would be retained and re-served the whole time; capped at 500.
 */
describe("control reason/label caps", () => {
  test("caps a long help reason at 500 characters", () => {
    const control = createControl();
    const state = control.requestHelp("r".repeat(2000));
    expect(state.reason).toHaveLength(500);
  });

  test("caps a long secret label at 500 characters", () => {
    const control = createControl();
    const state = control.requestSecret({ label: "l".repeat(2000), ref: "e1" });
    expect(state.secretWanted).toHaveLength(500);
  });
});

/**
 * T02: the browser launch under an external isolation runtime.
 *
 * OpenShell is the boundary (landlock policy, seccomp, per-sandbox network policy), so Chromium's
 * own process sandbox is unavailable there — exactly the compensating-control situation the image
 * already documents for managed containers. Under that declared runtime the launch additionally
 * needs `--no-zygote` (the sandbox's seccomp profile refuses zygote fork) and
 * `--ignore-certificate-errors` (the supervisor's transparent proxy terminates TLS). Nothing may
 * add those flags when no external runtime is declared: an unknown declaration is refused rather
 * than silently treated as "no isolation".
 */
describe("hardened launch under an external isolation runtime", () => {
  test("chromium_hardened_launch_refuses_unsafe_fallback", async () => {
    const { browserRuntimeFromEnv } = await import("../src/browser-runtime");
    const external = browserRuntimeFromEnv(
      {
        COMPUTER_ISOLATION_RUNTIME: "openshell",
        COMPUTER_BROWSER_MODE: "headless",
      },
      "linux",
    );
    expect(external.isolation).toBe("external");

    const plain = browserRuntimeFromEnv(
      { COMPUTER_BROWSER_MODE: "headless" },
      "linux",
    );
    expect(plain.isolation).toBe("none");

    // A typo or an unsupported runtime must not read as "no isolation".
    expect(() =>
      browserRuntimeFromEnv(
        { COMPUTER_ISOLATION_RUNTIME: "best-effort" },
        "linux",
      ),
    ).toThrow(/COMPUTER_ISOLATION_RUNTIME/);

    const { launchArgs } = await import("../src/profiles");
    const hardened = launchArgs(external);
    expect(hardened).toContain("--no-zygote");
    expect(hardened).toContain("--ignore-certificate-errors");

    // The control: without the declaration neither flag appears, so a launch cannot quietly
    // acquire sandbox-runtime flags the deployment never claimed.
    const ordinary = launchArgs(plain);
    expect(ordinary).not.toContain("--no-zygote");
    expect(ordinary).not.toContain("--ignore-certificate-errors");
  });
});
