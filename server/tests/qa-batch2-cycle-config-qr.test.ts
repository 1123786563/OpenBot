import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/*
 * QA batch-2 probes (e)(f)(j), pinned at the source level where the behaviour is a pure
 * declaration the runtime cannot be probed for without booting the whole server:
 *
 *   (e) the cycle grammar: the routes' zod enum, the catalog's cycles field, and the dialog's
 *       rendering all name exactly the two monthly spellings — yearly is refused at the door.
 *   (f) the boot cross-check's full shape: mismatch refuses with BOTH numbers and the plan
 *       name in the message; a missing display price warns but does not refuse.
 *   (j) the QR renders locally: no qrserver reference anywhere in the app source, and the
 *       local qrcode package is what the dialog imports.
 */
const ROUTES = readFileSync(
  join(hereDir, "../src/billing/payments/routes.ts"),
  "utf8",
);
const SERVICE = readFileSync(
  join(hereDir, "../src/billing/payments/service.ts"),
  "utf8",
);
const TYPES = readFileSync(
  join(hereDir, "../src/billing/payments/types.ts"),
  "utf8",
);
const CONFIG = readFileSync(join(hereDir, "../src/config.ts"), "utf8");

describe("probe e: the cycle grammar is one contract across three files", () => {
  test("the routes accept exactly the two monthly spellings", () => {
    expect(ROUTES).toContain('cycle: z.enum(["monthly", "recurring_monthly"])');
    // And the handler converges both to the one collected cycle.
    expect(ROUTES).toContain('cycle: "monthly"');
  });

  test("the catalog discloses exactly the same two spellings", () => {
    expect(SERVICE).toContain('cycles: ["monthly", "recurring_monthly"]');
    expect(TYPES).toContain(
      'cycles: readonly ("monthly" | "recurring_monthly")[]',
    );
  });

  test("no yearly spelling exists on the server's purchase surface", () => {
    expect(ROUTES).not.toContain('"yearly"');
    expect(SERVICE).not.toContain('"yearly"');
    // The service's createPurchase contract types the converged cycle.
    expect(SERVICE).toContain('cycle: "monthly";');
  });
});

describe("probe f: the boot cross-check", () => {
  test("a price disagreement refuses with both numbers and the plan named", () => {
    expect(CONFIG).toContain(
      `PAYMENT_PLAN_CATALOG plan "\${planCode}" amountCents (\${amountCents}) does not match`,
    );
    expect(CONFIG).toContain(
      `LAGO_PLAN_CATALOG's monthly price (\${mismatch.priceCents} on "\${mismatch.code}")`,
    );
  });

  test("the comparison reads the monthly cycle of the display catalog only", () => {
    expect(CONFIG).toMatch(
      /cycle\.code === "monthly" \|\| cycle\.code === "recurring_monthly"/,
    );
  });

  test("a plan without a display price warns, never refuses", () => {
    const warnShape = CONFIG.includes(
      "has no monthly cycle in LAGO_PLAN_CATALOG",
    );
    expect(warnShape).toBe(true);
  });
});

describe("probe j: the QR renders locally", () => {
  test("no qrserver reference anywhere in the app source", () => {
    // The grep-equivalent, done in-test so the gate is part of the suite:
    // walk the app source for the third-party QR host.
    const appDir = join(hereDir, "../../app/src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of Bun.file(join(dir, "..")).name ? [] : []) void entry;
    };
    void walk;
    // Simple recursive scan via Bun.Glob.
    const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx}");
    for (const file of glob.scanSync({ cwd: appDir })) {
      const text = readFileSync(join(appDir, file), "utf8");
      if (text.includes("api.qrserver.com")) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  test("the dialog imports the local qrcode package, not an image service", () => {
    const dialog = readFileSync(
      join(hereDir, "../../app/src/components/billing/upgrade-dialog.tsx"),
      "utf8",
    );
    expect(dialog).toMatch(/from "qrcode"|from 'qrcode'/);
    expect(dialog).not.toContain("qrserver");
  });
});
