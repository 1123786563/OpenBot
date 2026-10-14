import { describe, expect, test } from "bun:test";
import {
  actsOnTheComputer,
  isOpenPath,
  matchesToken,
  offeredToken,
} from "../src/authorisation";

/**
 * The check that stands in front of a Bot's browser.
 *
 * Every case here is one that was reachable before it existed: taking the wheel, navigating a live
 * page, listing the Bot's files, with no sign-in and no audit row.
 */

const SECRET = "a-long-development-secret";

describe("matching the secret", () => {
  test("the right secret is accepted", () => {
    expect(matchesToken(SECRET, SECRET)).toBeTrue();
  });

  test("a wrong secret of the same length is refused", () => {
    const wrong = `${SECRET.slice(0, -1)}X`;
    expect(wrong).toHaveLength(SECRET.length);
    expect(matchesToken(SECRET, wrong)).toBeFalse();
  });

  test("a correct prefix is refused", () => {
    // The case the constant-time comparison exists for: guessing forwards must not get warmer.
    expect(matchesToken(SECRET, SECRET.slice(0, 5))).toBeFalse();
  });

  test("an empty offer is refused", () => {
    expect(matchesToken(SECRET, "")).toBeFalse();
  });

  test("an empty EXPECTED secret refuses everything, including an empty offer", () => {
    // A computer that came up without a secret must be unreachable rather than open to anybody who
    // also sends nothing, which is what a plain equality check would have done.
    expect(matchesToken("", "")).toBeFalse();
    expect(matchesToken("", "anything")).toBeFalse();
  });
});

describe("finding the secret a caller offered", () => {
  const url = (path: string) => new URL(`http://computer.test${path}`);

  test("a header", () => {
    const headers = new Headers({ "x-openbot-computer-token": SECRET });
    expect(offeredToken(headers, url("/snapshot"))).toBe(SECRET);
  });

  test("a bearer token", () => {
    const headers = new Headers({ authorization: `Bearer ${SECRET}` });
    expect(offeredToken(headers, url("/snapshot"))).toBe(SECRET);
  });

  test("the stream takes it from the query, because a browser upgrade carries no headers", () => {
    const headers = new Headers();
    expect(offeredToken(headers, url(`/stream?bot=b&token=${SECRET}`))).toBe(
      SECRET,
    );
  });

  test("the stream also accepts the header — the server proxy prefers it so the token stays off the URL", () => {
    // Both forms are checked against the same secret; the header is the one
    // the OpenBot proxy uses (round 6 M5): a query string would land the
    // deployment token in access logs.
    const headers = new Headers({ "x-openbot-computer-token": SECRET });
    expect(offeredToken(headers, url("/stream?bot=b"))).toBe(SECRET);
  });

  test("nothing offered is an empty string, not a crash", () => {
    expect(offeredToken(new Headers(), url("/snapshot"))).toBe("");
  });
});

describe("what an unauthenticated caller may reach", () => {
  test("health, and nothing else", () => {
    expect(isOpenPath("/health")).toBeTrue();
    for (const path of [
      "/control/take",
      "/navigate",
      "/snapshot",
      "/files/list",
      "/files/read",
      "/files/download",
      "/stream",
      "/live",
      "/",
    ]) {
      expect(isOpenPath(path)).toBeFalse();
    }
  });
});

/**
 * Which paths the wheel stops.
 *
 * A person takes the wheel at a login wall precisely because they no longer want the Bot acting, and
 * `control.ts` states the property outright: "While a person holds control every acting call from the
 * Bot is refused". That was true of the page from the start and untrue of the shell, which arrived
 * later (#62) and was never wired to the wheel, so a Bot could run a command and rewrite the
 * workspace underneath somebody mid-sign-in.
 *
 * The list lives here, beside the other path decision, rather than in `index.ts`, for the reason the
 * header of this file gives: a decision next to `chromium.launch()` cannot be tested without Chrome.
 *
 * Reading is not acting. `/files/read` and `/files/list` stay open so a Bot waiting to be handed the
 * wheel back can still say what it was doing.
 */
describe("what the wheel stops while a person is driving", () => {
  test("every path that acts on the computer, the shell and a workspace write included", () => {
    for (const path of [
      "/navigate",
      "/click",
      "/type",
      "/key",
      "/scroll",
      "/exec",
      "/files/write",
    ]) {
      expect(actsOnTheComputer(path)).toBeTrue();
    }
  });

  test("reading, looking and the handover itself are not acting", () => {
    for (const path of [
      "/files/read",
      "/files/list",
      "/snapshot",
      "/screenshot",
      "/health",
      "/control",
      "/control/take",
      "/control/release",
      "/stream",
    ]) {
      expect(actsOnTheComputer(path)).toBeFalse();
    }
  });
});
