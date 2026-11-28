import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";

const { BUILD_MANIFEST, EVIDENCE_DIR, FIXTURE_APP_URL, FIXTURE_API_URL } =
  process.env;
assert(BUILD_MANIFEST && EVIDENCE_DIR && FIXTURE_APP_URL && FIXTURE_API_URL);
for (const url of [FIXTURE_APP_URL, FIXTURE_API_URL]) {
  assert.equal(new URL(url).hostname, "127.0.0.1");
}
const build = JSON.parse(await readFile(BUILD_MANIFEST, "utf8"));
const index = await fetch(FIXTURE_APP_URL);
assert(index.ok);
assert.equal(
  createHash("sha256")
    .update(await index.text())
    .digest("hex"),
  build.indexSha256,
);
const setup = await fetch(new URL("/__fixture/governance", FIXTURE_API_URL), {
  method: "PUT",
  body: JSON.stringify({
    firstBatch: true,
    edition: "personal",
    role: "admin",
  }),
});
assert.equal(setup.headers.get("x-openbot-fixture"), "isolated");
assert(setup.ok);
const session = await fetch(
  new URL("/__fixture/session?signedIn=true", FIXTURE_API_URL),
  {
    redirect: "manual",
  },
);
assert.equal(session.status, 302);
await mkdir(EVIDENCE_DIR, { recursive: true });

function sampleContrast() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  function rgba(color) {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  }
  function luminance([r, g, b]) {
    const channels = [r, g, b].map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  return [
    ...document.querySelectorAll(
      '[role="alert"], [role="alert"] *, [role="alertdialog"] h2, [role="alertdialog"] p, [role="alertdialog"] button, [role="alertdialog"] button *',
    ),
  ].flatMap((element) => {
    const label = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(" ")
      .trim();
    if (
      !label ||
      !element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      })
    )
      return [];
    const text = rgba(getComputedStyle(element).color);
    if (text[3] !== 255) return [];
    const layers = [];
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.opacity !== "1" || style.backgroundImage !== "none") return [];
      const background = rgba(style.backgroundColor);
      if (background[3] === 0) continue;
      if (background[3] !== 255) {
        layers.push(background);
        continue;
      }
      for (const [r, g, b, alpha] of layers.reverse()) {
        const ratio = alpha / 255;
        for (const [index, channel] of [r, g, b].entries()) {
          background[index] = Math.round(
            channel * ratio + background[index] * (1 - ratio),
          );
        }
      }
      const first = luminance(text);
      const second = luminance(background);
      return [
        {
          label,
          kind: element.closest('[role="alert"]')
            ? "alert"
            : element.closest("button")
              ? "button"
              : "dialog text",
          ratio:
            (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        },
      ];
    }
    return [];
  });
}

const records = [];
for (const [engine, theme] of [
  [chromium, "light"],
  [chromium, "dark"],
  [webkit, "light"],
  [webkit, "dark"],
]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 320, height: 820 },
      colorScheme: theme,
      locale: engine === webkit ? "zh-CN" : "en-US",
    });
    await page.addInitScript(
      (value) => localStorage.setItem("openbot-theme", value),
      theme,
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const now = new Date().toISOString();
    const task = {
      id: "review",
      agentId: "inbox",
      channelId: "review",
      threadId: null,
      title: "Review notes",
      origin: "check_in",
      status: "ready_for_review",
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    let writes = 0;
    let reopens = 0;
    let approvalsReady = false;
    const chinese = engine === webkit;
    const labels = chinese
      ? {
          mark: "标记为完成",
          cancel: "取消",
          retry: "重试",
          reopen: "重新打开",
          resolved: "已解决",
        }
      : {
          mark: "Mark done",
          cancel: "Cancel",
          retry: "Try again",
          reopen: "Reopen",
          resolved: "Resolved",
        };
    await page.route("**/api/approvals", (route) =>
      approvalsReady
        ? route.continue()
        : route.fulfill({ status: 503, json: {} }),
    );
    await page.route("**/api/tasks", (route) =>
      route.fulfill({ json: { tasks: [task] } }),
    );
    await page.route("**/api/tasks/review/resolve", (route) => {
      writes++;
      task.status = "resolved";
      task.resolvedAt = now;
      return route.fulfill({ status: 503, json: {} });
    });
    await page.route("**/api/tasks/review/reopen", (route) => {
      reopens++;
      task.status = "ready_for_review";
      task.resolvedAt = null;
      return route.fulfill({ json: { task } });
    });
    await page.goto(new URL("/tasks", FIXTURE_APP_URL).href);
    const retryApprovals = page.getByRole("button", {
      name: chinese ? "重新加载审批和问题" : "Retry approvals and questions",
    });
    await retryApprovals.waitFor({ timeout: 15000 });
    assert.equal(
      await retryApprovals.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    );
    const approvalsContrast = await page.evaluate(sampleContrast);
    approvalsReady = true;
    await retryApprovals.press("Enter");
    await retryApprovals.waitFor({ state: "hidden" });
    const mark = page.getByRole("button", { name: labels.mark, exact: true });
    const metadata = page.locator('[data-slot="item-description"]').filter({
      hasText: chinese ? "待审阅" : "Ready for review",
    });
    await metadata.waitFor({ timeout: 15000 });
    const metadataLayout = await metadata.evaluate((element) => ({
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      clipped:
        element.scrollWidth > element.clientWidth ||
        element.scrollHeight > element.clientHeight,
    }));
    assert(
      metadataLayout.fontSize >= 12,
      "Task metadata must be at least 12 CSS pixels",
    );
    assert.equal(metadataLayout.clipped, false);
    await mark.press("Enter", { timeout: 15000 });
    const dialog = page.getByRole("alertdialog", {
      name: chinese
        ? "将「Review notes」标记为完成？"
        : "Mark Review notes done?",
    });
    const cancel = dialog.getByRole("button", { name: labels.cancel });
    await page.waitForFunction(
      (label) => document.activeElement?.textContent?.trim() === label,
      labels.cancel,
    );
    await cancel.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      (label) => document.activeElement?.textContent?.trim() === label,
      labels.mark,
    );
    assert.equal(writes, 0);
    await page.keyboard.press("Enter");
    await dialog.waitFor();
    await dialog.evaluate(async (element) => {
      await Promise.allSettled(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const dialogContrast = await page.evaluate(sampleContrast);
    await page.screenshot({
      path: `${process.env.EVIDENCE_DIR}/${engine.name()}-${theme}-confirm.png`,
    });
    await dialog
      .getByRole("button", { name: chinese ? "标记为完成" : "Mark done" })
      .press("Enter");
    const retry = dialog.getByRole("button", { name: labels.retry });
    await retry.waitFor();
    const retryFrames = [];
    for (let frame = 0; frame < 8; frame++) {
      const samples = await page.evaluate(sampleContrast);
      retryFrames.push(
        samples.find((sample) => sample.label === labels.retry)?.ratio,
      );
    }
    await retry.evaluate(async (element) => {
      await Promise.allSettled(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const writeErrorContrast = await page.evaluate(sampleContrast);
    await retry.press("Enter");
    await page
      .getByText(
        chinese
          ? "已将「Review notes」标记为完成。可在「已解决」中重新打开。"
          : "Marked Review notes done. Reopen it under Resolved.",
      )
      .waitFor();
    await page
      .getByRole("button", { name: labels.reopen, exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: labels.resolved, exact: true })
      .waitFor();
    assert.equal(writes, 1);
    const reopen = page.getByRole("button", {
      name: labels.reopen,
      exact: true,
    });
    await reopen.press("Enter");
    await page
      .getByRole("button", { name: labels.mark, exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: labels.resolved, exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(reopens, 1);
    assert.deepEqual(errors, []);
    records.push({
      browser: engine.name(),
      theme,
      retryFrames,
      metadataLayout,
      reopens,
      approvalsContrast,
      dialogContrast,
      writeErrorContrast,
      approvalsRetry: true,
      cancelsWithoutWrite: true,
      restoresFocus: true,
      writes,
      resolved: true,
    });
    await page.screenshot({
      path: `${process.env.EVIDENCE_DIR}/${engine.name()}-${theme}-resolved.png`,
    });
  } catch (error) {
    const pages = browser.contexts()[0]?.pages();
    if (pages?.[0]) console.log(await pages[0].locator("body").innerText());
    throw error;
  } finally {
    await browser.close();
  }
}
await writeFile(
  join(EVIDENCE_DIR, "run.json"),
  JSON.stringify({ build, records }, null, 2),
);
for (const { browser, theme, retryFrames } of records) {
  assert(
    retryFrames.every((ratio) => Number.isFinite(ratio) && ratio >= 4.5),
    `${browser} ${theme}: Retry contrast fell below 4.5:1 or could not be sampled (${retryFrames.join(", ")})`,
  );
}
