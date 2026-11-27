import { expect, test } from "bun:test";
import { assertPageAccess, navigateWebPage } from "../src/navigation";

function fixture() {
  let url = "https://example.com/";
  let failure = true;
  const visited: string[] = [];
  const page: Parameters<typeof navigateWebPage>[0] = {
    url: () => url,
    waitForFunction: async () => ({ dispose: async () => {} }),
    async goto(target) {
      visited.push(target);
      if (failure) {
        failure = false;
        url = "chrome-error://chromewebdata/";
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }
      url = target;
      return null;
    },
  };
  return { page, visited };
}

test("a failed navigation can recover from Chrome's internal error page without exposing it", async () => {
  const { page, visited } = fixture();
  await expect(
    navigateWebPage(page, "http://127.0.0.1:64110/", "local-chrome", 1000),
  ).rejects.toThrow("ERR_CONNECTION_REFUSED");
  expect(() => assertPageAccess("local-chrome", page.url())).toThrow(
    /only web pages/,
  );
  assertPageAccess("local-chrome", page.url(), "navigate");
  await navigateWebPage(
    page,
    "https://example.com/recovered",
    "local-chrome",
    1000,
  );
  expect(visited).toEqual([
    "http://127.0.0.1:64110/",
    "https://example.com/recovered",
  ]);
  expect(() => assertPageAccess("local-chrome", page.url())).not.toThrow();
});

test("navigation never accepts file/chrome targets or returns a nonweb redirect result", async () => {
  const { page, visited } = fixture();
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
  ]) {
    expect(() => assertPageAccess("local-chrome", url)).toThrow();
    await expect(
      navigateWebPage(page, url, "local-chrome", 1000),
    ).rejects.toThrow();
  }
  expect(visited).toHaveLength(0);
  const redirected: Parameters<typeof navigateWebPage>[0] = {
    goto: async () => null,
    waitForFunction: fixture().page.waitForFunction,
    url: () => "file:///private/secret",
  };
  await expect(
    navigateWebPage(
      redirected,
      "https://example.com/redirect",
      "local-chrome",
      1000,
    ),
  ).rejects.toThrow(/only web pages/);
  expect(() => assertPageAccess("local-chrome", "about:blank")).not.toThrow();
});

test("navigation waits for a readable document after the new page commits", async () => {
  const events: string[] = [];
  const page: Parameters<typeof navigateWebPage>[0] = {
    url: () => "https://example.com/",
    async goto(_, options) {
      expect(options?.waitUntil).toBe("commit");
      events.push("committed");
      return null;
    },
    async waitForFunction(_, __, options) {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(1000);
      events.push("readable");
      return {
        async dispose() {
          events.push("disposed");
        },
      };
    },
  };

  await navigateWebPage(page, "https://example.com/", "local-chrome", 1000);
  expect(events).toEqual(["committed", "readable", "disposed"]);
});
