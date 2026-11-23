import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import { client } from "@/lib/client";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * The sentences the frame itself owns when a request fails: the client's generic fallback, the
 * shared ReadError retry button, and the router's recovery screens. The caller's `fallback`,
 * `retryLabel`, `message` and `description` are page-owned sentences and must stay as the page
 * wrote them, in any language.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(async () => {
  cleanup();
  await pinLocale("en");
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Swaps in what the server says next, failing without a JSON envelope: no message of its own. */
function theServerSaysNoMessage(): void {
  globalThis.fetch = (async () =>
    new Response("boom", { status: 500 })) as unknown as typeof fetch;
}

test("the generic request failure speaks the interface language", async () => {
  theServerSaysNoMessage();
  await expect(client("http://x.test/things", {})).rejects.toThrow(
    "That request failed.",
  );

  await pinLocale("zh-CN");

  await expect(client("http://x.test/things", {})).rejects.toThrow("请求失败。");
});

/** Fails with an envelope carrying the server's own sentence. */
function theServerSaysItsOwn(message: string): void {
  globalThis.fetch = (async () =>
    Response.json({ error: message }, {
      status: 422,
    })) as unknown as typeof fetch;
}

test("a message from the server is kept verbatim, in either language", async () => {
  const serverSays = "每小时最多创建 3 个 Bot。";
  theServerSaysItsOwn(serverSays);
  await expect(client("http://x.test/things", {})).rejects.toThrow(serverSays);

  await pinLocale("zh-CN");

  await expect(client("http://x.test/things", {})).rejects.toThrow(serverSays);
});

/** Answers 200 with a body that is not an envelope. */
function aMalformedSuccess(): void {
  globalThis.fetch = (async () =>
    new Response("null", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("a malformed success gets the same fallback, and a page's own sentence wins", async () => {
  aMalformedSuccess();
  await pinLocale("zh-CN");
  await expect(
    client("http://x.test/thing", "thing", {}),
  ).rejects.toThrow("请求失败。");

  aMalformedSuccess();
  await expect(
    client("http://x.test/thing", "thing", { fallback: "Nope." }),
  ).rejects.toThrow("Nope.");
});
