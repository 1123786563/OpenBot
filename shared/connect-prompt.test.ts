import { describe, expect, test } from "../tests/support/e2e-compat";
import {
  CONNECT_APP_MARKER,
  connectAppRefusal,
  readConnectPrompt,
  type ConnectPrompt,
} from "./connect-prompt";

/**
 * The contract the transcript and the server share about a connect refusal.
 *
 * The server buries a small JSON and a sentence after {@link CONNECT_APP_MARKER} in the refusal a
 * `PluginRefusedError` already carries; the transcript reads the same string back to draw a card.
 * Both sides of that wire are one file's business, and these tests are the executable half of it.
 *
 * Two properties matter more than any single case below. The parser FAILS CLOSED — anything it does
 * not fully recognise is null, because a card drawn from a half-read refusal would offer to connect
 * something nobody named. And the reader is DISPLAY ONLY — a plain tool result, including one a
 * vendor wrote that merely contains the marker, never becomes a prompt, because the codec answers
 * nothing about permissions and the connect endpoint re-checks the actor on its own.
 */
const prompt: ConnectPrompt = {
  serverId: "google-drive",
  title: "Google Drive",
  message:
    "You have not connected your Google Drive account. Connect it in Settings and ask again.",
};

describe("a refusal this server wrote", () => {
  test("roundtrips whole, with a title holding a closing brace, quotes and a backslash", () => {
    // The upstream parser took the FIRST `}` as the end of the JSON, so a title like this one
    // truncated the payload and the card was lost along with it. Scanning to the brace that
    // actually closes the object — string literals and escapes respected — is the whole fix, and
    // this is the case that would have caught the defect.
    const hostile: ConnectPrompt = {
      serverId: "notion",
      title: `Sizes > 2} and "quotes" and \\ backslashes`,
      message: `The } in the title must not end the JSON early. {"not":"a prompt"}`,
    };
    expect(readConnectPrompt(connectAppRefusal(hostile))).toEqual(hostile);
  });

  test("roundtrips the ordinary refusal the store produces", () => {
    expect(readConnectPrompt(connectAppRefusal(prompt))).toEqual(prompt);
  });

  test("keeps the sentence readable after the JSON, for a client that draws no card", () => {
    const refusal = connectAppRefusal(prompt);
    expect(refusal.startsWith(CONNECT_APP_MARKER)).toBe(true);
    expect(refusal.endsWith(prompt.message)).toBe(true);
  });

  test("clamps over-long fields, so everything the server emits still parses back", () => {
    const oversized: ConnectPrompt = {
      serverId: "s".repeat(500),
      title: "t".repeat(500),
      message: "m".repeat(10_000),
    };
    const read = readConnectPrompt(connectAppRefusal(oversized));
    expect(read?.serverId).toBe("s".repeat(256));
    expect(read?.title).toBe("t".repeat(200));
    expect(read?.message.length).toBeLessThanOrEqual(4_000);
    // The payload cap is enforced on the writer too, escape inflation included: a serverId of
    // control characters JSON-escapes sixfold, and the message gives way before the cap is met.
    const escapeHeavy: ConnectPrompt = {
      serverId: "\u0001".repeat(256),
      title: "\u0001".repeat(200),
      message: "m".repeat(10_000),
    };
    const escaped = readConnectPrompt(connectAppRefusal(escapeHeavy));
    expect(escaped?.serverId).toBe("\u0001".repeat(256));
    expect(
      connectAppRefusal(escapeHeavy).length - CONNECT_APP_MARKER.length,
    ).toBeLessThanOrEqual(8_192);
  });

  test("clamps without splitting a surrogate pair", () => {
    // One Astral-plane character past the cut: slicing the string in half by code units would
    // strand half of it, and a lone surrogate round-trips as U+FFFD. Backing off one keeps the
    // roundtrip exact.
    const astral: ConnectPrompt = {
      serverId: "notion",
      title: `${"🍊".repeat(120)}🍊`,
      message: "connect",
    };
    const read = readConnectPrompt(connectAppRefusal(astral));
    expect(read?.title.length).toBeLessThanOrEqual(200);
    expect(read?.title.endsWith("🍊")).toBe(true);
  });
});

describe("a text that is not a refusal this server wrote", () => {
  test("answers null for ordinary text, null and undefined", () => {
    expect(readConnectPrompt("[vendor not reached in tests]")).toBeNull();
    expect(
      readConnectPrompt(
        "Refused. You have not connected your Google Drive account.",
      ),
    ).toBeNull();
    expect(readConnectPrompt(null)).toBeNull();
    expect(readConnectPrompt(undefined)).toBeNull();
    expect(readConnectPrompt("")).toBeNull();
  });

  test("answers null when the marker only appears mid-text — display, never a signal", () => {
    // A vendor's own answer is somebody else's data, and it can be written to look like anything.
    // Only a refusal that STARTS with the marker is ours; anything a vendor result embeds is text
    // the reader leaves alone, which is what keeps a tool result from promoting itself into a
    // permission-shaped prompt.
    expect(
      readConnectPrompt(
        `The vendor reported an error:\nsee [connect-app]{"serverId":"x","title":"y"} inside`,
      ),
    ).toBeNull();
  });

  test("answers null for a truncated or malformed payload", () => {
    expect(readConnectPrompt(CONNECT_APP_MARKER)).toBeNull();
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}{"serverId":"x"`),
    ).toBeNull();
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}{"serverId":"x","title":"t`),
    ).toBeNull();
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}not json at all`),
    ).toBeNull();
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}{"serverId" "x"`),
    ).toBeNull();
  });

  test("answers null when the JSON is not an object of the right shapes", () => {
    expect(readConnectPrompt(`${CONNECT_APP_MARKER}["a","b"]`)).toBeNull();
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}"just a string"`),
    ).toBeNull();
    expect(readConnectPrompt(`${CONNECT_APP_MARKER}42`)).toBeNull();
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}{"serverId":1,"title":"t"}`),
    ).toBeNull();
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}{"serverId":"s","title":null}`),
    ).toBeNull();
    // `message` rides as the text after the JSON, not inside it, and there is no lower bound on it.
    expect(
      readConnectPrompt(`${CONNECT_APP_MARKER}{"serverId":"s","title":"t"}`),
    ).toEqual({ serverId: "s", title: "t", message: "" });
  });

  test("answers null when a field breaks its length bound", () => {
    expect(
      readConnectPrompt(
        `${CONNECT_APP_MARKER}${JSON.stringify({
          serverId: "s".repeat(257),
          title: "t",
        })} m`,
      ),
    ).toBeNull();
    expect(
      readConnectPrompt(
        `${CONNECT_APP_MARKER}${JSON.stringify({
          serverId: "s",
          title: "t".repeat(201),
        })} m`,
      ),
    ).toBeNull();
    expect(
      readConnectPrompt(
        `${CONNECT_APP_MARKER}${JSON.stringify({ serverId: "", title: "t" })} m`,
      ),
    ).toBeNull();
    expect(
      readConnectPrompt(
        `${CONNECT_APP_MARKER}${JSON.stringify({ serverId: "s", title: "" })} m`,
      ),
    ).toBeNull();
    expect(
      readConnectPrompt(
        `${CONNECT_APP_MARKER}${JSON.stringify({
          serverId: "s",
          title: "t",
        })} ${"m".repeat(4_001)}`,
      ),
    ).toBeNull();
  });

  test("answers null for a payload over the cap, however well-formed its fields", () => {
    // The bounds below are individually fine; the payload they ride in is not. A cap on the whole
    // payload is what stops an unbounded message from travelling inside a tool result.
    const bloated = `${CONNECT_APP_MARKER}${JSON.stringify({
      serverId: "s",
      title: "t",
    })} ${" ".repeat(9_000)}m`;
    expect(bloated.length - CONNECT_APP_MARKER.length).toBeGreaterThan(8_192);
    expect(readConnectPrompt(bloated)).toBeNull();
  });
});
