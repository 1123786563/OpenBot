import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personSeat } from "../src/computer/computer-key";
import { createOpenShellExecution } from "../src/computer/openshell-execution";

test("a failed OpenShell restart leaves the existing workspace for operator recovery", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "openbot-openshell-start-"));
  const cli = join(fixture, "openshell");
  const calls = `${cli}.calls`;
  try {
    await writeFile(
      `${cli}.inventory`,
      JSON.stringify({
        sandboxes: [
          {
            name: "ob-1kwbe10a4po5okau",
            phase: "Stopped",
            labels: {
              "openbot-execution":
                "34ac9443bbe1e9eb02c752449d2fd6ec63aa213dad03b3103945d0e33126",
            },
          },
        ],
        next_page_token: "",
      }),
    );
    await writeFile(
      cli,
      `#!/bin/sh
shift 6
printf '%s\\n' "$1 $2" >> "$0.calls"
case "$2" in
  list) cat "$0.inventory" ;;
  start)
    printf '%s\\n' 'start sandbox failed: sandbox not found' >&2
    exit 1
    ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    const execution = createOpenShellExecution(
      {
        cli,
        gateway: "fixture",
        workspace: "default",
        image: "fixture",
        pilotUsers: new Set(["pilot"]),
        token: "fixture-token",
        networkPolicies: {},
      },
      async (_owner, run) => run(),
    );
    await expect(
      execution.connect(personSeat("pilot", "notes")),
    ).rejects.toThrow("Contact an operator to recover the workspace.");
    expect(await readFile(calls, "utf8")).toBe("sandbox list\nsandbox start\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
