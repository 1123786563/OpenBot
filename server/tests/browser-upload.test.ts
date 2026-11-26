import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { approvalPhrase } from "../../shared/tool-name";
import { createComputerGateway } from "../src/computer/gateway";
import { createSharedComputerProvider } from "../src/computer/provider";

test("a pilot upload asks for one attempt with a file and site, and an unknown outcome needs another decision", async () => {
  const inputs = {
    path: "reports/sales.csv",
    url: "https://example.com/import",
    field: "file",
  };
  let approvals = 0;
  let allowed = false;
  let dispatches = 0;
  let transfers = 0;
  let humanRequests = 0;
  let identity = "first";
  let content = "YSxiCg==";
  let digest: unknown;
  const gateway = createComputerGateway({
    provider: createSharedComputerProvider({ baseUrl: "http://127.0.0.1:1" }),
    browserProvider: {
      serves: () => true,
      locate: async () => "http://127.0.0.1:2",
      status: async (seat) => ({
        botId: seat.botId,
        state: "unreachable",
        reason: "fixture",
      }),
      tokenFor: () => "fixture",
    },
    execution: {
      pilotUsers: new Set(["pilot"]),
      connect: async () => ({ url: "http://127.0.0.1:3" }),
    },
    auditStore: { insert: async () => {} },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    approvalGate: async (candidate) => {
      approvals++;
      expect(candidate.requireOneTime).toBe(true);
      expect(approvalPhrase(candidate)).toContain("sales.csv");
      expect(approvalPhrase(candidate)).toContain(candidate.scope);
      if (!allowed) throw new Error("Human decision required");
      if (digest === undefined) digest = candidate.target;
      else if (JSON.stringify(digest) !== JSON.stringify(candidate.target)) {
        throw new Error("Target changed, new approval required");
      }
      allowed = false;
      return { approvalId: "fixture-approval", complete: async () => {} };
    },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.port === "3") {
        expect(url.pathname).toBe("/files/browser-upload");
        expect(url.searchParams.get("path")).toBe(inputs.path);
        const includeContent = url.searchParams.get("content") === "1";
        if (includeContent) transfers++;
        return Response.json({
          identity,
          sha256: createHash("sha256")
            .update(Buffer.from(content, "base64"))
            .digest("hex"),
          ...(includeContent ? { content } : {}),
        });
      }
      expect(url.port).toBe("2");
      if (url.pathname === "/human/browser-upload") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          by: "pilot",
          name: "sales.csv",
        });
        humanRequests++;
        return Response.json({ status: "accepted", httpStatus: 201 });
      }
      expect(url.pathname).toBe("/browser-upload");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        url: inputs.url,
        field: inputs.field,
        name: "sales.csv",
        content,
      });
      dispatches++;
      throw new Error("Lost response");
    },
  });
  const seat = await gateway.seatFor("notes", "pilot");
  const actor = { id: "pilot", userId: "pilot" };
  const upload = (input = inputs) =>
    gateway.uploadBrowserFile!(seat, actor, input);
  await expect(upload()).rejects.toThrow("Human decision required");
  expect(dispatches).toBe(0);
  expect(transfers).toBe(0);
  allowed = true;
  expect(await upload()).toMatchObject({ status: "unknown" });
  await expect(upload()).rejects.toThrow("Human decision required");
  expect(dispatches).toBe(1);
  allowed = true;
  content = "YyxkCg==";
  await expect(upload()).rejects.toThrow("Target changed");
  content = "YSxiCg==";
  identity = "replaced-with-identical-bytes";
  await expect(upload()).rejects.toThrow("Target changed");
  identity = "first";
  await expect(
    upload({ ...inputs, url: "https://elsewhere.example/import" }),
  ).rejects.toThrow("Target changed");
  expect(approvals).toBe(6);
  expect(transfers).toBe(1);
  if (!gateway.humanUploadBrowserFile)
    throw new Error("Missing takeover route");
  await expect(
    gateway.humanUploadBrowserFile(seat, { id: "someone-else" }, inputs),
  ).rejects.toThrow("Pilot workspace not found");
  await expect(
    gateway.humanUploadBrowserFile(seat, actor, inputs),
  ).resolves.toEqual({ status: "accepted", httpStatus: 201 });
  expect(approvals).toBe(6);
  expect(humanRequests).toBe(1);
  expect(dispatches).toBe(1);
});
