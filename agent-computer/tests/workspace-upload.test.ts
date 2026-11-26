import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../src/workspace";
import { snapshotWorkspaceUpload } from "../src/workspace-upload";

test.skipIf(process.platform !== "linux")(
  "the execution snapshot reads one regular workspace file and detects an identical replacement",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-upload-"));
    try {
      const workspace = createWorkspace(root);
      const file = join(root, "report.csv");
      await writeFile(file, "a,b\n");
      const original = await snapshotWorkspaceUpload(
        workspace,
        root,
        "report.csv",
      );
      expect(original.content).toBeUndefined();
      const full = await snapshotWorkspaceUpload(
        workspace,
        root,
        "report.csv",
        true,
      );
      expect(full.content).toBe("YSxiCg==");
      expect(full.sha256).toBe(original.sha256);

      await writeFile(join(root, "new.csv"), "a,b\n");
      await rename(join(root, "new.csv"), file);
      const replaced = await snapshotWorkspaceUpload(
        workspace,
        root,
        "report.csv",
      );
      expect(replaced.sha256).toBe(original.sha256);
      expect(replaced.identity).not.toBe(original.identity);

      await symlink(file, join(root, "alias.csv"));
      await expect(
        snapshotWorkspaceUpload(workspace, root, "alias.csv"),
      ).rejects.toThrow();
      await expect(
        snapshotWorkspaceUpload(workspace, root, "../report.csv"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
