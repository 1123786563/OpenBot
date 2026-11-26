import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";

test.skipIf(process.env.OPENBOT_COMPUTER_BROWSER !== "1")(
  "the browser-only computer stages a completed Bot download under its initiating Bot",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-chromium-download-"));
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const binary = new Uint8Array([123, 0, 255, 18]);
    let attachmentRequests = 0;
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/download") {
          attachmentRequests++;
          return new Response(binary, {
            headers: {
              "content-disposition": 'attachment; filename="report.bin"',
            },
          });
        }
        return new Response(
          "<button autofocus onclick=\"location.href='/download'\">Download</button>",
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    });
    const token = "pilot-browser-download-fixture";
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "src/index.ts"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          COMPUTER_TOKEN: token,
          PORT: String(port),
          COMPUTER_PERSON_ID: "download-owner",
          OPENBOT_BROWSER_ONLY: "on",
          COMPUTER_BROWSER_BACKEND: "managed",
          COMPUTER_BROWSER_MODE: "headless",
          EGRESS_POLICY_REQUIRED: "0",
          PROFILES_DIR: join(root, "profiles"),
          WORKSPACE_DIR: join(root, "workspace"),
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const call = (
      path: string,
      body?: object,
      botId = "notes",
      secret = token,
    ) =>
      fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-computer-token": secret,
          "x-openbot-bot-id": botId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      const deadline = Date.now() + 10_000;
      while (
        !(await call("/health")
          .then((response) => response.ok)
          .catch(() => false))
      ) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error("The browser-only computer failed to start.");
        await Bun.sleep(50);
      }
      const address = new URL("/download", site.url).href;
      const opened = await call("/navigate", { url: address });
      expect(opened.status).toBe(200);
      const navigation = await opened.json();
      expect(navigation.browserDownload).toMatchObject({ status: "ready" });
      const id = navigation.browserDownload.id;
      const path = `/browser-downloads/${id}`;

      expect((await call(path, undefined, "different-bot")).status).toBe(404);
      expect(
        (await call(path, undefined, "notes", "other-person-token")).status,
      ).toBe(401);
      const staged = await call(path);
      expect(staged.status).toBe(200);
      expect(new Uint8Array(await staged.arrayBuffer())).toEqual(binary);

      expect((await call("/navigate", { url: site.url.href })).status).toBe(
        200,
      );
      const snapshot = await (await call("/snapshot", {})).json();
      const click = await call("/click", {
        ref: snapshot.elements[0].ref,
        snapshotId: snapshot.snapshotId,
      });
      expect(click.status).toBe(200);
      const clicked = await click.json();
      expect(clicked.browserDownload).toMatchObject({ status: "ready" });
      const clickedId = clicked.browserDownload.id;
      expect(clickedId).not.toBe(id);
      expect(
        new Uint8Array(
          await (await call(`/browser-downloads/${clickedId}`)).arrayBuffer(),
        ),
      ).toEqual(binary);

      expect((await call("/navigate", { url: site.url.href })).status).toBe(
        200,
      );
      const asked = await call("/control/request", {
        reason: "Take the wheel",
      });
      const control = await asked.json();
      expect(
        (
          await call("/control/take", {
            requestId: control.request.id,
            by: "download-owner",
          })
        ).status,
      ).toBe(200);
      expect((await call("/human/key", { key: "Enter" })).status).toBe(200);
      const waitForManual = Date.now() + 3000;
      while (attachmentRequests < 3 && Date.now() < waitForManual)
        await Bun.sleep(25);
      expect(attachmentRequests).toBe(3);
      expect(
        (
          await readdir(join(root, "profiles", "notes", ".openbot-downloads"))
        ).sort(),
      ).toEqual([id, clickedId].sort());
    } finally {
      child.kill();
      await child.exited;
      await site.stop(true);
      await rm(root, { force: true, recursive: true });
    }
  },
  25_000,
);
