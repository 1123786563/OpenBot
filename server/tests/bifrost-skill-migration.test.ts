import { expect, test } from "bun:test";
import {
  decodeImportedSkillDocument,
  encodeImportedSkillDocument,
} from "../src/skill-market/imported-document";

test("the exact-version reader restores original SKILL.md bytes through Bifrost JSONB", () => {
  const original = Buffer.from(
    "\uFEFF---\r\n# preserved comment\r\nname: fixture\r\ndescription: 'Fixture skill'\r\nmetadata:\r\n  openbot-compatibility: {scripts: false}\r\n---\r\n\r\nBody.\r\n",
  );
  const document = encodeImportedSkillDocument(original, "fixture");
  const stored = JSON.parse(JSON.stringify(document.snapshot));
  expect(decodeImportedSkillDocument("fixture", document.body, stored)).toEqual(
    original,
  );
  expect(() =>
    decodeImportedSkillDocument("fixture", document.body, {
      ...stored,
      description: "Different skill",
    }),
  ).toThrow("frontmatter");
});
