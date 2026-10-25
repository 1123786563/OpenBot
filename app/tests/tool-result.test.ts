import "./preload";
import { connectAppRefusal } from "../../shared/connect-prompt";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { HANDED_OVER, PUT_TO } from "../src/lib/copilot/markers";
import {
  asText,
  forDisplay,
  mayBeRefusal,
  refusalAndAnswer,
  refusalBody,
  saidItWentAhead,
  toolResultFailed,
} from "../src/lib/plugins/tool-result";

/**
 * What a tool actually said, recovered from how the transcript carries it.
 *
 * A tool returns a string and the runtime puts it into a message as JSON, so everything arriving at
 * the screen is encoded. Getting this wrong is not only ugly: the refusal marker is matched against
 * the start of this text, and an encoded string starts with a quote.
 */
describe("reading a tool's answer", () => {
  test("a JSON-encoded string is unwrapped, escapes and all", () => {
    const refusal =
      'This deployment\'s policy does not allow that: search_notes on notes is blocked by the rule `mcp.server == "notes"`.';
    expect(asText(JSON.stringify(refusal))).toBe(refusal);
  });

  test("a refusal is still recognisable as one after decoding", () => {
    const encoded = JSON.stringify("Refused. The rule says no.");
    // The check the transcript makes. Against the raw text it is false, which is the bug.
    expect(encoded.startsWith("Refused.")).toBe(false);
    expect(asText(encoded).startsWith("Refused.")).toBe(true);
  });

  test("plain text is left alone", () => {
    expect(asText("Meals under $75 need no receipt.")).toBe(
      "Meals under $75 need no receipt.",
    );
  });

  /*
   * An envelope is not a string, and unwrapping one here would take the vendor's structure apart
   * before forDisplay has had the chance to find the answer inside it.
   */
  test("a JSON object or array is left for forDisplay", () => {
    expect(asText('{"results":"# Found"}')).toBe('{"results":"# Found"}');
    expect(asText("[1,2]")).toBe("[1,2]");
  });

  test("something that only looks like JSON is drawn as it came", () => {
    expect(asText('"unterminated')).toBe('"unterminated');
  });

  test("an encoded envelope is decoded and then unwrapped", () => {
    expect(forDisplay(JSON.stringify('{"results":"# Found\\n\\nBody"}'))).toBe(
      "# Found\n\nBody",
    );
  });
});

/**
 * The two lines a hop draws.
 *
 * Both read an outcome out of the tool's own prose, which is what a server-side tool leaves
 * available, and both read it through `asText` for the reason above: matched against the raw value
 * the prefix never matches, and every accepted hop was drawn as Blocked.
 */
describe("telling an accepted hop from a refused one", () => {
  /*
   * Read from the server's own source, not retyped.
   *
   * These markers cross a network: the server writes the sentence and the transcript reads its first
   * words. Nothing coupled the two ends, so a rewording on the server left every accepted hop drawn
   * as Blocked with the whole suite green — which is the bug both renderers' comments recount. The
   * test imports the browser's copies and asserts they still match the server's.
   */
  const handedOver = HANDED_OVER;
  const putTo = PUT_TO;

  test("an accepted handoff is not a refusal, encoded or not", () => {
    const said = `${handedOver}Knowledge. It will answer in its own conversation.`;
    expect(asText(JSON.stringify(said)).startsWith(handedOver)).toBe(true);
    expect(asText(said).startsWith(handedOver)).toBe(true);
  });

  test("a cap refusing a hop does not start with the marker", () => {
    const said =
      "This turn has already asked 3 Bots, which is as many as this deployment allows.";
    expect(asText(JSON.stringify(said)).startsWith(handedOver)).toBe(false);
  });

  test("a question that reached somebody is not drawn as one that did not", () => {
    const said = `${putTo}the person in this conversation. Ask it in your own words now.`;
    expect(asText(JSON.stringify(said)).startsWith(putTo)).toBe(true);
  });

  test("a route that reached nobody does not start with the marker", () => {
    const said = "The on-call rota is not configured.";
    expect(asText(JSON.stringify(said)).startsWith(putTo)).toBe(false);
  });
});

/**
 * The two ends of a phrase that crosses a network.
 *
 * The server writes the sentence; the transcript reads its first words to decide whether to draw a
 * hop or a boundary. One declaration in `shared/handoff-markers.ts` means the two cannot disagree
 * about the phrase, so what is left to hold is how the transcript READS a result — which is what
 * this block does. That the sentences still begin with these markers is asserted where the sentences
 * are written: `server/tests/agent-handoff-tool.test.ts` and `agent-escalation.test.ts`.
 */
describe("the markers the server and the transcript both use", () => {
  /*
   * A result that is neither a string nor absent used to mean success to one renderer and a refusal
   * to the other, for the same situation. Anything unrecognisable is not success: a boundary that
   * held drawn as a Bot getting on with it is the worse of the two mistakes.
   */
  test("an unrecognisable result is never drawn as success", () => {
    expect(saidItWentAhead({ some: "object" }, HANDED_OVER)).toBe(false);
    expect(saidItWentAhead(42, PUT_TO)).toBe(false);
  });

  test("a result that has not arrived yet is left to the caller's status", () => {
    expect(saidItWentAhead(undefined, HANDED_OVER)).toBe(true);
  });
});

describe("telling a failed tool from a successful one", () => {
  test("vendor errors are failures, encoded or not", () => {
    const answer = "The vendor reported an error:\\npermission denied";
    expect(toolResultFailed(answer)).toBe(true);
    expect(toolResultFailed(JSON.stringify(answer))).toBe(true);
  });

  test("runtime/deployment call failures are failures", () => {
    expect(toolResultFailed("That tool could not be called.")).toBe(true);
    expect(
      toolResultFailed("That tool could not be called: connection reset"),
    ).toBe(true);
  });

  test("ordinary results, refusals, and running calls are not failures", () => {
    expect(toolResultFailed("Found 12 results.")).toBe(false);
    expect(toolResultFailed("Refused. The rule says no.")).toBe(false);
    expect(toolResultFailed(undefined)).toBe(false);
  });
});

/**
 * JSON the parser accepts but the stringifier cannot redraw.
 *
 * V8's JSON.stringify recurses once per nesting level and gives up (`RangeError: Maximum call
 * stack size exceeded`) on legal documents far shallower than JSON.parse reads. forDisplay is the
 * one door every tool result passes through on the way to the screen, so the drawing falls back to
 * the text the server sent, fenced as JSON — nothing thrown, nothing lost.
 */
describe("JSON that parses but is too deep to redraw", () => {
  test("a deeply nested array is drawn as the text the server sent", () => {
    const deep = `${"[".repeat(100000)}0${"]".repeat(100000)}`;
    let drawn: string | undefined;
    expect(() => {
      drawn = forDisplay(deep);
    }).not.toThrow();
    expect(drawn).toBe(`\`\`\`json\n${deep}\n\`\`\``);
  });

  test("a markdown envelope whose rest is too deep to redraw draws the envelope once, not the body twice", () => {
    const deep = `${"[".repeat(100000)}0${"]".repeat(100000)}`;
    const envelope = `{"results":"# Found\\n\\nBody","meta":${deep}}`;
    let drawn: string | undefined;
    expect(() => {
      drawn = forDisplay(envelope);
    }).not.toThrow();
    if (drawn === undefined) throw new Error("forDisplay drew nothing");
    // The fence that cannot be redrawn holds the whole envelope as it arrived, drawn exactly
    // once. Standing the rendered body in front of it would show the same words twice — once as
    // the markdown, once more inside the envelope — so the envelope stands alone.
    expect(drawn).toBe(`\`\`\`json\n${envelope}\n\`\`\``);
    expect(drawn.split("# Found").length - 1).toBe(1);
  });
});

/**
 * The shapes a refusal arrives in, recognised cheaply — the check the fold's fast path reads.
 *
 * The fold asks whether a result could be asking the person something before its cache or a parse
 * is ever consulted, and the check lives in `tool-result`, beside the `refusalBody` strip it
 * fronts for, so the gate and the strip answer from one declaration instead of the call site
 * restating the rule and the two drifting apart. The pin that matters is the direction: the cheap
 * check may let through what the strip then answers null for, and never the other way round — a
 * question the full reading draws must never be folded away by a cheap look at first characters.
 */
describe("the fold's cheap refusal shape-check", () => {
  test("recognises the two shapes a refusal arrives in, padding and all", () => {
    expect(mayBeRefusal("Refused. The policy does not allow that.")).toBe(true);
    expect(
      mayBeRefusal(JSON.stringify("Refused. The policy does not allow that.")),
    ).toBe(true);
    expect(mayBeRefusal("  Refused. Padded by a vendor's formatting.")).toBe(
      true,
    );
  });

  test("an ordinary result never opens like one", () => {
    expect(mayBeRefusal("Found 12 results.")).toBe(false);
    expect(mayBeRefusal(JSON.stringify("vendor answer"))).toBe(false);
    expect(mayBeRefusal('{"results":"a vendor envelope"}')).toBe(false);
    expect(mayBeRefusal("The answer was Refused. mid-sentence")).toBe(false);
  });

  test("lets through everything the full strip draws a refusal from, and only that way round", () => {
    const wire = JSON.stringify(
      `Refused. ${connectAppRefusal({
        serverId: "github",
        title: "GitHub",
        message: "Connect your GitHub account and ask again.",
      })}`,
    );
    const results = [
      "Refused. The policy does not allow that.",
      JSON.stringify("Refused. The policy does not allow that."),
      `  ${wire}`,
      JSON.stringify("The answer was Refused. mid-sentence"),
      '{"results":"a vendor envelope, not text"}',
      wire,
    ];
    for (const result of results) {
      if (refusalBody(result) !== null) {
        expect(mayBeRefusal(result)).toBe(true);
      }
    }
    // The pin is not vacuous: the wire's own refusal and a padded one both strip, look-alikes
    // never do, and the superset direction is real — an unterminated encoding passes the cheap
    // check while the strip still answers null.
    expect(refusalBody(wire)).not.toBeNull();
    expect(refusalBody(`  ${wire}`)).not.toBeNull();
    expect(refusalBody(results[3])).toBeNull();
    expect(mayBeRefusal('"Refused. unterminated')).toBe(true);
    expect(refusalBody('"Refused. unterminated')).toBeNull();
  });
});

/**
 * Both questions a completed result gets asked, answered from one read of its envelope.
 *
 * `stepDetails` and `ServerToolLine` each want to know whether a result is a refusal and what
 * text it carries, and asking through two calls read the envelope twice — the strip decoded it
 * once to answer null, and the caller decoded it again for the body that verdict left behind.
 */
describe("a result's refusal and answer from one decode", () => {
  test("a refusal yields its body; the answer is the whole decoded text", () => {
    const read = refusalAndAnswer(
      JSON.stringify("Refused. The workspace policy does not allow that."),
    );
    expect(read.refusal).toBe("The workspace policy does not allow that.");
    expect(read.answer).toBe(
      "Refused. The workspace policy does not allow that.",
    );
  });

  test("an ordinary result yields no refusal and its answer from the same read", () => {
    const read = refusalAndAnswer(JSON.stringify("vendor answer"));
    expect(read.refusal).toBeNull();
    expect(read.answer).toBe("vendor answer");
  });

  test("a result that has not arrived yet answers nothing, both ways", () => {
    expect(refusalAndAnswer(undefined)).toEqual({
      refusal: null,
      answer: undefined,
    });
  });

  test("agrees with the two calls it replaces, on every shape a result arrives in", () => {
    const results: (string | undefined)[] = [
      undefined,
      JSON.stringify("Refused. The policy does not allow that."),
      "Refused. Bare text, carried without the runtime's encoding.",
      `  ${JSON.stringify("Refused. The policy does not allow that.")}`,
      JSON.stringify("The answer was Refused. mid-sentence"),
      '{"results":"a vendor envelope, not text"}',
      '"Refused. unterminated',
    ];
    for (const result of results) {
      const read = refusalAndAnswer(result);
      expect(read.refusal).toBe(refusalBody(result));
      expect(read.answer).toBe(
        result === undefined ? undefined : asText(result),
      );
    }
  });

  test("costs one parse per read, whichever way the verdict goes", () => {
    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      parses += 1;
      return realParse(...args);
    }) as typeof JSON.parse;
    try {
      expect(
        refusalAndAnswer(JSON.stringify("vendor answer")).refusal,
      ).toBeNull();
      expect(
        refusalAndAnswer(JSON.stringify("Refused. No, and here is why."))
          .refusal,
      ).toBe("No, and here is why.");
    } finally {
      JSON.parse = realParse;
    }
    expect(parses).toBe(2);
  });
});
