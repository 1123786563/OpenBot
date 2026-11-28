import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";

const { EVIDENCE_DIR, BUILD_MANIFEST, FIXTURE_APP_URL, FIXTURE_API_URL } =
  process.env;
assert(EVIDENCE_DIR && BUILD_MANIFEST && FIXTURE_APP_URL && FIXTURE_API_URL);
for (const url of [FIXTURE_APP_URL, FIXTURE_API_URL])
  assert.equal(new URL(url).hostname, "127.0.0.1");

const build = JSON.parse(await readFile(BUILD_MANIFEST, "utf8"));
const index = await fetch(FIXTURE_APP_URL);
assert(index.ok);
assert.equal(
  createHash("sha256")
    .update(await index.text())
    .digest("hex"),
  build.indexSha256,
);
const setup = await fetch(`${FIXTURE_API_URL}/__fixture/governance`, {
  method: "PUT",
  body: JSON.stringify({ firstBatch: true, edition: "personal" }),
});
assert(setup.ok);
assert.equal(setup.headers.get("x-openbot-fixture"), "isolated");
const session = await fetch(
  `${FIXTURE_API_URL}/__fixture/session?signedIn=true`,
  { redirect: "manual" },
);
assert.equal(session.status, 302);

const requestId = "fixture-sign-in";
const savedUsername = `${"long-account-name".repeat(12)}@example.test`;
const requestPath = `/api/sign-in-requests/${requestId}`;
const result = await fetch(FIXTURE_API_URL + requestPath);
assert(result.ok);
const request = await result.json();
assert.equal(request.status, "pending");
const rosterResponse = await fetch(`${FIXTURE_API_URL}/api/channels`);
assert(rosterResponse.ok);
const { channels } = await rosterResponse.json();
const conversation = channels.find(
  (channel) => channel.threadId && channel.agentIds.length === 1,
);
assert(conversation, "The fixture needs a direct conversation with a Thread");

const browserName = process.env.WEBSITE_SIGN_IN_BROWSER ?? "chromium";
const engine = { chromium, webkit }[browserName];
assert(engine, "WEBSITE_SIGN_IN_BROWSER must be chromium or webkit");
const browser = await engine.launch();
const tabKey =
  browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
const cases = [];
try {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      const height = width === 390 ? 844 : 900;
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        locale: "en-US",
      });
      try {
        await context.addInitScript((value) => {
          localStorage.setItem("openbot-theme", value);
        }, theme);
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        let status = "unavailable";
        let reads = 0;
        let writes = 0;
        await page.route(`**${requestPath}**`, (route) => {
          if (route.request().method() !== "GET") {
            writes++;
            return route.abort();
          }
          reads++;
          if (status === "unavailable")
            return route.fulfill({
              status: 503,
              json: { error: "Fixture vendor error" },
            });
          return route.fulfill({
            json: {
              ...request,
              status,
              threadId: conversation.threadId,
              savedLogins: [
                { id: "fixture-saved-login", username: savedUsername },
              ],
              origin:
                "https://a-long-account-sign-in-subdomain.staging.example.test",
            },
          });
        });
        await page.goto(`${FIXTURE_APP_URL}/sign-in/${requestId}`);
        const retry = page.getByRole("button", { name: "Retry" });
        await retry.waitFor();
        const focused = (locator) =>
          locator.evaluate((element) => element === document.activeElement);
        for (let tab = 0; tab < 10 && !(await focused(retry)); tab++)
          await page.keyboard.press(tabKey);
        assert(await focused(retry));
        status = "pending";
        await page.keyboard.press("Enter");
        const password = page.getByLabel("Password");
        await password.waitFor();
        await page
          .getByRole("heading", { name: "Sign in for your Bot" })
          .waitFor();
        await page.waitForFunction(
          () =>
            document.activeElement?.textContent?.trim() ===
            "Sign in for your Bot",
        );
        assert.equal(await page.getByText("Fixture vendor error").count(), 0);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        const account = page.getByText(savedUsername, { exact: true });
        await account.waitFor();
        const accountLayout = await account.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const lines = [...range.getClientRects()];
          return {
            lineCount: new Set(lines.map((line) => line.top)).size,
            fitsViewport: lines.every(
              (line) => line.left >= 0 && line.right <= innerWidth,
            ),
          };
        });
        assert(accountLayout.fitsViewport);
        if (width === 390) assert(accountLayout.lineCount > 1);
        await page.screenshot({
          path: join(EVIDENCE_DIR, `${width}-${theme}-restored.png`),
        });

        status = "code_required";
        await page.reload();
        const code = page.getByLabel("Verification code");
        await code.waitFor();
        assert.equal(await password.count(), 0);
        await page.screenshot({
          path: join(EVIDENCE_DIR, `${width}-${theme}-verification.png`),
        });

        status = "expired";
        await page.reload();
        await page
          .getByRole("region", { name: "This sign-in link expired" })
          .waitFor();
        assert.equal(await password.count(), 0);
        assert.equal(await code.count(), 0);
        await page.screenshot({
          path: join(EVIDENCE_DIR, `${width}-${theme}-expired.png`),
        });
        const returnLink = page.getByRole("link", {
          name: "Return to conversation",
        });
        await returnLink.waitFor();
        const destination = `/channel/${conversation.id}`;
        assert.equal(await returnLink.getAttribute("href"), destination);
        for (let tab = 0; tab < 10 && !(await focused(returnLink)); tab++)
          await page.keyboard.press(tabKey);
        assert(await focused(returnLink));
        await page.keyboard.press("Enter");
        await page.waitForURL(`${FIXTURE_APP_URL}${destination}`);
        assert.equal(writes, 0);
        cases.push({
          width,
          height,
          theme,
          reads,
          writes,
          retryFocusRestored: true,
          accountLayout,
          verificationFormRestored: true,
          expiredFormRemoved: true,
          returnedToConversation: destination,
        });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  join(EVIDENCE_DIR, "run.json"),
  JSON.stringify({ build, browser: browserName, cases }, null, 2),
);
