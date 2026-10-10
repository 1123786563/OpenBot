import { describe, expect, test } from "bun:test";

import {
  digestMessages,
  runInputDigest,
} from "../../src/enterprise/runs/input-digest";

/*
 * Gold vectors computed by the Go candidate's trustedinput.DigestMessages on
 * the SAME inputs (runtime-go/internal/trustedinput/input.go). These four are
 * the TS↔Go cross-check: if either side changes its frozen serialization the
 * vectors go red before any run can disagree mid-flight.
 */
const GO_GOLD_VECTORS: Array<{ input: Array<{ content: string; role: "user" }>; digest: string }> = [
  {
    input: [{ content: "hello", role: "user" }],
    digest: "d98167dd28f22e330824942ba4d4ce217c2411a0d1141d60b40fe4cb8dc0d232",
  },
  {
    input: [{ content: "你好，世界！\"quoted\" <html> & ⏩", role: "user" }],
    digest: "a57fc2b3eccf8ffdbc442374ea19897342f5bd35ab16f7a07089e12e3514b11a",
  },
  {
    input: [{ content: "line1\u2028line2\u2029end", role: "user" }],
    digest: "183d0cd90816d2ed2bd6c6fc26d9812d6a727b92a0ed161f8ab16c36f6fe4607",
  },
  {
    input: [
      { content: "a", role: "user" },
      { content: "b", role: "user" },
    ],
    digest: "ad46f8cfd632a2a82478480779fde13cf017f79ab8cb5c484b47a8ab6b3af6a5",
  },
];

describe("runInputDigest (frozen TS↔Go gold vectors)", () => {
  for (const [index, vector] of GO_GOLD_VECTORS.entries()) {
    test(`gold vector #${index + 1} matches the Go candidate byte for byte`, () => {
      expect(digestMessages(vector.input)).toBe(vector.digest);
    });
  }

  test("the single-text helper hashes exactly the one-message canonical form", () => {
    expect(runInputDigest({ text: "hello" })).toBe(GO_GOLD_VECTORS[0]!.digest);
  });

  test("message order changes the digest", () => {
    const [a, b] = GO_GOLD_VECTORS[3]!.input;
    expect(digestMessages([b!, a!])).not.toBe(GO_GOLD_VECTORS[3]!.digest);
  });
});
