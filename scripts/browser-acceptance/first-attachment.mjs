import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { salesBot } from "./governance-fixture.mjs";

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
assert.equal(setup.headers.get("x-openbot-fixture"), "isolated");
assert(setup.ok);
const session = await fetch(
  `${FIXTURE_API_URL}/__fixture/session?signedIn=true`,
  { redirect: "manual" },
);
assert.equal(session.status, 302);
const { user } = await (await fetch(`${FIXTURE_API_URL}/api/me`)).json();
assert(user.id);

const browser = await chromium.launch();
const cases = [];
try {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      const name = `${width}-${theme}`;
      const originalStart = randomUUID();
      const startKey = `openbot:conversation-start:${encodeURIComponent(user.id)}:${originalStart}`;
      const originalId = randomUUID();
      const newAttachmentId = randomUUID();
      const threadId = randomUUID();
      const channelId = "attachment-handoff";
      const message = "Review the attached planning brief.";
      const bytes = "The original attachment survives a recipient change.";
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        colorScheme: theme,
        serviceWorkers: "block",
      });
      try {
        await context.addInitScript(
          ({ key, value, theme }) => {
            localStorage.setItem("openbot-theme", theme);
            localStorage.setItem(key, value);
            Object.defineProperty(navigator.clipboard, "writeText", {
              value: () =>
                Promise.reject(
                  new DOMException("Clipboard is denied.", "NotAllowedError"),
                ),
            });
          },
          {
            key: startKey,
            value: JSON.stringify({
              state: "pending",
              progress: { phase: "creating" },
              draft: {
                text: message,
                commandIds: [],
                attachments: [
                  {
                    attachmentId: originalId,
                    name: "brief.txt",
                    mimeType: "text/plain",
                    type: "document",
                  },
                ],
                recipient: { kind: "route" },
              },
            }),
            theme,
          },
        );
        const channel = {
          id: channelId,
          name: "Attachment handoff",
          active: true,
          direct: true,
          agentIds: [salesBot.id],
          threadId,
          lastMessageAt: null,
        };
        let reads = 0;
        let upload;
        let create;
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== FIXTURE_APP_URL) return route.abort();
          if (url.pathname === "/api/route" && request.method() === "POST")
            return route.fulfill({
              status: 409,
              json: { error: "Choose a Bot.", names: [salesBot.name] },
            });
          if (url.pathname === `/api/attachments/${originalId}`) {
            reads++;
            return reads === 1
              ? route.fulfill({ status: 503, json: { error: "Read failed." } })
              : route.fulfill({
                  status: 200,
                  contentType: "text/plain",
                  body: bytes,
                });
          }
          if (url.pathname === "/api/channels" && request.method() === "POST") {
            create = request.postDataJSON();
            return route.fulfill({ status: 201, json: { channel } });
          }
          if (url.pathname === `/api/channels/${channelId}/attachments`) {
            upload = request.postDataBuffer()?.toString();
            return route.fulfill({
              status: 201,
              json: {
                id: newAttachmentId,
                name: "brief.txt",
                mimeType: "text/plain",
              },
            });
          }
          if (url.pathname === `/api/channels/${channelId}`)
            return route.fulfill({ status: 200, json: { channel } });
          return route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${FIXTURE_APP_URL}/start/${originalStart}`);
        await page.getByRole("button", { name: "Copy message text" }).click();
        const copy = page.getByRole("textbox", { name: "Saved message text" });
        await copy.waitFor();
        const clipboardFallback = await copy.evaluate((field) => ({
          value: field.value,
          selectedText: field.value.slice(
            field.selectionStart,
            field.selectionEnd,
          ),
          readOnly: field.readOnly,
          focused: document.activeElement === field,
        }));
        assert.deepEqual(clipboardFallback, {
          value: message,
          selectedText: message,
          readOnly: true,
          focused: true,
        });
        assert.equal(create, undefined);
        assert.equal(upload, undefined);
        const clipboardScreenshot = `${name}-clipboard.png`;
        await page.screenshot({
          path: join(EVIDENCE_DIR, clipboardScreenshot),
        });
        await page
          .getByRole("button", { name: "Choose Bots in a new conversation" })
          .click();
        await page.getByRole("heading", { name: "New conversation" }).waitFor();
        await page.getByRole("combobox", { name: "To" }).fill(salesBot.name);
        await page
          .getByRole("option", { name: new RegExp(salesBot.name) })
          .click();
        const add = page.getByRole("button", {
          name: "Add original attachments",
        });
        await add.click();
        await page
          .getByRole("alert")
          .filter({ hasText: "Couldn't read the original attachments" })
          .waitFor();
        await add.click();
        await page.getByRole("button", { name: "Remove brief.txt" }).waitFor();
        assert.equal(reads, 2);
        assert.equal(create, undefined);
        assert.equal(upload, undefined);
        await page.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) });
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click();
        await page.waitForURL(`**/channel/${channelId}`);
        assert.deepEqual(create.agentIds, [salesBot.id]);
        assert.notEqual(create.requestId, originalStart);
        assert(upload.includes(bytes));
        assert(upload.includes('filename="brief.txt"'));
        assert(!upload.includes(originalId));
        const original = await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)),
          startKey,
        );
        assert.equal(original.draft.attachments[0].attachmentId, originalId);
        assert.deepEqual(errors, []);
        cases.push({
          width,
          theme,
          reads,
          newUpload: true,
          originalPreserved: true,
          clipboardFallback,
          clipboardScreenshot,
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
  JSON.stringify({ build, cases }, null, 2),
);
