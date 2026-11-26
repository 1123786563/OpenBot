// Run against a final build served with /api proxied to the isolated fixture API.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { boundaryRuleId } from "../../shared/boundary-rule-id.ts";
import { boundary, boundaryName } from "./governance-fixture.mjs";

const {
  FIXTURE_APP_URL: app,
  FIXTURE_API_URL: api,
  EVIDENCE_DIR: out,
  BUILD_MANIFEST: manifest,
} = process.env;
assert(
  app && api && out && manifest,
  "Set FIXTURE_APP_URL, FIXTURE_API_URL, EVIDENCE_DIR and BUILD_MANIFEST.",
);
for (const address of [app, api]) {
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname),
    "Use an isolated loopback fixture.",
  );
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = await readFile(manifest);
const build = JSON.parse(manifestBytes);
const index = await fetch(new URL("/", app), { redirect: "error" });
assert(index.ok, "Final build index did not load.");
assert.equal(sha256(Buffer.from(await index.arrayBuffer())), build.indexSha256);
const control = `${api}/__fixture/governance`;
const detail = `/admin/boundaries/${boundaryRuleId(boundary)}`;
await mkdir(join(out, "screenshots"), { recursive: true });

async function fixture(method, body) {
  const response = await fetch(control, {
    method,
    ...(body && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  assert(
    response.ok && response.headers.get("x-openbot-fixture") === "isolated",
  );
  return response.json();
}

const cells = [];
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const theme of ["light", "dark"]) {
    const cell = { viewport, theme, cases: [] };
    cells.push(cell);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport,
        colorScheme: theme,
        locale: "en-US",
      });
      page.setDefaultTimeout(6000);
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === new URL(app).origin
          ? route.continue()
          : route.abort(),
      );
      await page.addInitScript(
        (scheme) => localStorage.setItem("openbot-theme", scheme),
        theme,
      );
      const heading = (name) =>
        page.getByRole("heading", { name, exact: true });
      const button = (name) => page.getByRole("button", { name, exact: true });
      const role = (name, accessibleName) =>
        page.getByRole(name, { name: accessibleName, exact: true });
      const text = (value) => page.getByText(value, { exact: true });
      const visible = (target) => target.waitFor({ state: "visible" });
      let result;

      async function press(key) {
        await page.keyboard.press(key);
        result.focus.push({
          key,
          active: await page.evaluate(() => {
            const el = document.activeElement;
            return {
              tag: el?.tagName,
              name:
                el?.getAttribute("aria-label") ||
                el?.textContent?.trim().slice(0, 100),
              href: el?.getAttribute("href"),
            };
          }),
        });
      }

      async function reach(locator) {
        await visible(locator);
        for (let step = 0; step < 150; step += 1) {
          if (await locator.evaluate((el) => el === document.activeElement))
            return;
          await press("Tab");
        }
        throw new Error(`Tab did not reach ${locator}`);
      }

      async function activate(locator) {
        await visible(locator);
        for (let attempt = 0; !(await locator.isEnabled()); attempt += 1) {
          assert(attempt < 60, `Control did not become enabled: ${locator}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await reach(locator);
        await press("Enter");
      }

      async function shot(name) {
        const file = `screenshots/${viewport.width}-${theme}-${result.name}-${name}.png`;
        await page.screenshot({ path: join(out, file) });
        result.screenshots.push(file);
      }

      async function go(path, expected) {
        await page.goto(new URL(path, app).href, {
          waitUntil: "domcontentloaded",
        });
        await visible(expected);
      }

      async function run(name, scenario, exercise) {
        result = {
          name,
          identity: {
            source: "fixture",
            edition: scenario.edition ?? "team",
            role: scenario.role ?? "admin",
          },
          focus: [],
          screenshots: [],
        };
        cell.cases.push(result);
        try {
          await fixture("PUT", scenario);
          const session = await fetch(
            `${api}/__fixture/session?signedIn=true`,
            { redirect: "manual" },
          );
          assert.equal(session.status, 302);
          const proxy = await page.request.get(
            new URL("/api/capabilities", app).href,
          );
          assert.equal(proxy.headers()["x-openbot-fixture"], "isolated");
          await exercise();
        } catch (error) {
          result.error = String(error);
          await shot("failure").catch(() => {});
        } finally {
          const { requests } = await fixture("GET");
          result.writes = requests.filter(({ method }) => method !== "GET");
          result.requestCount = requests.length;
        }
      }

      for (const [path, name] of [
        ["/admin/boundaries", "Boundaries"],
        ["/admin/boundaries/new", "Add rule"],
        ["/admin/permissions", "Permissions"],
        ["/admin/approvals", "Team settings"],
        ["/settings/approvals", "Before a Bot acts"],
      ]) {
        await run(path.slice(1).replaceAll("/", "-"), {}, async () => {
          await go(path, heading(name));
          await shot("default");
        });
      }

      await run(
        "boundary-list-retry",
        { policyReadFailure: true },
        async () => {
          await go(
            "/admin/boundaries",
            text("The boundary could not be read."),
          );
          await shot("read-failure");
          await fixture("PATCH", { policyReadFailure: false });
          await activate(button("Retry"));
          await visible(text(boundaryName));
          await shot("recovered");
        },
      );

      await run(
        "boundary-detail",
        { policyReadFailure: true, policyConflict: true },
        async () => {
          await go("/admin/boundaries/0", heading("Choose a boundary"));
          await shot("legacy-recovery");
          assert.equal(
            (await fixture("GET")).requests.filter(
              ({ method }) => method === "PUT",
            ).length,
            0,
          );
          await go(detail, text("Couldn't load this boundary."));
          await shot("read-failure");
          await fixture("PATCH", { policyReadFailure: false });
          await activate(button("Retry"));
          await visible(heading(boundaryName));
          const rule = role("textbox", "Rule");
          const draft = 'page.host == "changed.example.test"';
          await reach(rule);
          await press("ControlOrMeta+a");
          await page.keyboard.insertText(draft);
          const back = role("link", "Boundaries");
          await activate(back);
          const dialog = role("alertdialog", "Discard boundary draft?");
          await visible(dialog);
          await shot("draft-confirmation");
          await press("Escape");
          await dialog.waitFor({ state: "hidden" });
          assert.equal(await rule.inputValue(), draft);
          await activate(button("Save rule"));
          await visible(button("Reload current boundaries"));
          assert.equal(await rule.inputValue(), draft);
          await shot("conflict");
          await activate(button("Reload current boundaries"));
          await activate(button("Save rule"));
          await button("Save rule").waitFor({ state: "hidden" });
          const { policy } = await fixture("GET");
          assert(policy.deny.includes(draft) && policy.deny.includes("false"));
          await shot("saved");
        },
      );

      for (const form of [
        {
          path: "approvals",
          title: "Describe team rules",
          label: "Describe the rules",
          noun: "rules",
          remove: "Remove rule 1",
          destination: "Approvals",
        },
        {
          path: "permissions",
          title: "Describe who can do what",
          label: "Describe the change",
          noun: "changes",
          remove: "Remove change 1",
          destination: "Permissions",
        },
      ]) {
        await run(`${form.path}-describe`, {}, async () => {
          await go(`/admin/${form.path}/describe`, heading(form.title));
          const input = role("textbox", form.label);
          await reach(input);
          await page.keyboard.insertText("Require review");
          const write = button(`Write ${form.noun}`);
          await activate(write);
          await activate(button(form.remove));
          await shot("undo-visible");
          await activate(button("Undo"));
          await activate(button(form.remove));
          await reach(input);
          await press("ControlOrMeta+a");
          await page.keyboard.insertText("allow this action");
          await activate(write);
          await visible(button(form.remove));
          await button("Undo").waitFor({ state: "hidden" });
          await shot("rewritten");
          await activate(button(`Save ${form.noun}`));
          await visible(heading(form.destination));
          await shot("saved");
        });
      }

      await run("audit-what-if", {}, async () => {
        await go("/admin/audit", button("Why?"));
        await activate(button("Why?"));
        await visible(heading("With current policy"));
        await shot("audit-why");
        await activate(text("Try a change"));
        await visible(heading("Test a policy"));
        await visible(
          page.locator("[data-what-if-chip]").filter({ hasText: "Gmail" }),
        );
        const ask = role("textbox", "Ask what would happen");
        await reach(ask);
        await page.keyboard.insertText("Could Sales send Gmail?");
        await activate(button("Ask"));
        await activate(button("Check"));
        const verdict = heading("What happens");
        await visible(verdict);
        await shot("checked");
        await fixture("PATCH", { whatIfDenied: true });
        await activate(button("Ask"));
        await visible(text("Policy testing access is unavailable."));
        await verdict.waitFor({ state: "hidden" });
        assert.equal(await ask.inputValue(), "");
        await shot("access-denied");
      });

      for (const [state, message] of [
        ["loading", "Loading people…"],
        ["empty", "Nobody has signed in yet"],
        ["failed", "Couldn't load people."],
        ["denied", "You don’t have access to this people list."],
      ]) {
        await run(`people-${state}`, { people: state }, async () => {
          await go("/admin/people", text(message));
          await shot(state);
          if (state === "failed") {
            await fixture("PATCH", { people: "empty" });
            await activate(button("Retry people list"));
            await visible(text("Nobody has signed in yet"));
            await shot("recovered");
          }
        });
      }

      if (viewport.width === 390) {
        await run("people-actions", {}, async () => {
          const trigger = button("Actions for member@example.test");
          await go("/admin/people", trigger);
          await activate(trigger);
          const stop = role("menuitem", "Stop computers");
          await visible(stop);
          for (let step = 0; step < 4; step += 1) {
            if (await stop.evaluate((el) => el === document.activeElement))
              break;
            await press("ArrowDown");
          }
          assert(await stop.evaluate((el) => el === document.activeElement));
          await press("Enter");
          const dialog = role(
            "alertdialog",
            "Stop computers for member@example.test?",
          );
          await visible(dialog);
          await shot("confirmation");
          await activate(button("Cancel"));
          await dialog.waitFor({ state: "hidden" });
          assert(await trigger.evaluate((el) => el === document.activeElement));
          assert.equal(
            (await fixture("GET")).requests.filter(
              ({ method }) => method === "POST",
            ).length,
            0,
          );
        });
      }

      await run("team-member", { role: "user", people: "denied" }, async () => {
        await page.goto(new URL("/admin/people", app).href);
        await page.waitForURL(new URL("/", app).href);
        await shot("admin-redirect");
      });

      await run("personal-approvals", { edition: "personal" }, async () => {
        await go("/settings/approvals", heading("Before a Bot acts"));
        await shot("default");
      });
    } finally {
      await browser.close();
    }
  }
}
await writeFile(
  join(out, "run.json"),
  JSON.stringify(
    { commit: build.commit, buildManifestSha256: sha256(manifestBytes), cells },
    null,
    2,
  ),
);
if (cells.some(({ cases }) => cases.some(({ error }) => error)))
  process.exitCode = 1;
