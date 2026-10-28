import { expect, mock, test } from "../../tests/support/e2e-compat";

test("builtin skill loading only treats a missing root as an empty tree", async () => {
  let nextError = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  const restore = mock.module("node:fs/promises", () => ({
    readdir: async () => {
      throw nextError;
    },
  }));

  try {
    const denied = await import(
      "../src/craft/builtin-skills/index.ts?ocr-permission"
    );
    await expect(
      denied.builtinSkillFilesFor({ connectedServerIds: new Set() }),
    ).rejects.toThrow("permission denied");

    nextError = Object.assign(new Error("missing skill root"), {
      code: "ENOENT",
    });
    const missing = await import(
      "../src/craft/builtin-skills/index.ts?ocr-missing-root"
    );
    expect(
      await missing.builtinSkillFilesFor({ connectedServerIds: new Set() }),
    ).toEqual(new Map());
  } finally {
    restore();
  }
});
