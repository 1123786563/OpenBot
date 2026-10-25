import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import {
  argsDigestFor,
  createMastraTools,
  type MastraToolOperation,
  MastraToolRefusal,
  VALID_BRIDGE_TOOL_NAME,
  VALID_TOOL_NAME,
} from "../src/mastra/tools";
import { createPluginStore } from "../src/plugins/store";
import { markUntrusted } from "../src/untrusted-content";

/*
 * ME04 (#476) T2: the controlled tool wrapper. Every GrantedTool mounts as a
 * Mastra tool whose execute IS the granted executor — one execute per model
 * call, original schema preserved, named refusals for reserved/colliding or
 * invalid names, and the stop/lease guard ahead of any external call. The
 * vendor's answer text is never re-worded here: the granted path's own
 * untrusted envelope and refusal marker pass through untouched.
 */

function tool(spec: Partial<GrantedTool> = {}): GrantedTool {
  const name = spec.name ?? "mcp__server__echo_tool";
  return {
    name,
    description: spec.description ?? "Echo the value back.",
    parameters: spec.parameters ?? z.object({ value: z.string() }),
    execute:
      spec.execute ??
      (async () => {
        throw new Error("test tool reached its default execute");
      }),
    ref: spec.ref ?? `server/${name}`,
    ...(spec.initiator ? { initiator: spec.initiator } : {}),
  };
}

/** Invokes the wrapped Mastra tool the way the engine does. */
async function callTool(
  wrapped: unknown,
  input: unknown,
  context: unknown = { agent: { toolCallId: "call_1" } },
): Promise<unknown> {
  const execute = (wrapped as { execute?: unknown }).execute;
  if (typeof execute !== "function") {
    throw new Error("wrapped tool exposes no execute");
  }
  return (execute as (input: unknown, context: unknown) => Promise<unknown>)(
    input,
    context,
  );
}

describe("createMastraTools wrapping", () => {
  it("granted_tool_executes_once", async () => {
    const calls: unknown[] = [];
    const granted = tool({
      execute: async (args) => {
        calls.push(args);
        return "echoed:hi";
      },
    });
    const operations: MastraToolOperation[] = [];
    const record = createMastraTools([granted], {
      onOperation: (operation) => operations.push(operation),
    });
    expect(Object.keys(record)).toEqual(["mcp__server__echo_tool"]);
    const result = await callTool(record.mcp__server__echo_tool, {
      value: "hi",
    });
    // Exactly one granted execute, with the model's original arguments, and
    // the vendor answer passed through untouched.
    expect(calls).toEqual([{ value: "hi" }]);
    expect(result).toBe("echoed:hi");
    // One operation identity, carrying the engine call id and a digest of
    // the exact arguments that went out.
    expect(operations).toHaveLength(1);
    expect(operations[0]!.toolName).toBe("mcp__server__echo_tool");
    expect(operations[0]!.toolCallId).toBe("call_1");
    expect(operations[0]!.argsDigest).toBe(argsDigestFor({ value: "hi" }));
    // A retry of the SAME engine call id keeps the same operationId; a new
    // call id mints a new one (ME05 recovery builds on this).
    await callTool(record.mcp__server__echo_tool, { value: "hi" });
    await callTool(
      record.mcp__server__echo_tool,
      { value: "hi2" },
      { agent: { toolCallId: "call_2" } },
    );
    expect(calls).toHaveLength(3);
    expect(operations).toHaveLength(3);
    expect(operations[0]!.operationId).toBe(operations[1]!.operationId);
    expect(operations[2]!.operationId).not.toBe(operations[0]!.operationId);
    // An execute whose context carries no engine call id is its own logical
    // operation — two unkeyed calls never merge into one identity, even with
    // byte-identical arguments.
    const unkeyedOperations = operations.length;
    await callTool(record.mcp__server__echo_tool, { value: "hi" }, {});
    await callTool(record.mcp__server__echo_tool, { value: "hi" }, {});
    expect(calls).toHaveLength(5);
    expect(operations).toHaveLength(unkeyedOperations + 2);
    expect(operations[unkeyedOperations]!.operationId).not.toBe(
      operations[unkeyedOperations + 1]!.operationId,
    );
    // The original zod schema rides along: an argument the grant's schema
    // rejects never reaches the granted execute (the mounted schema
    // validates before the wrapper runs).
    await callTool(record.mcp__server__echo_tool, { value: 42 });
    expect(calls).toHaveLength(5);
  });

  it("ungranted_tool_is_absent", () => {
    // Only what the grant + selection handed over is mounted. A tool the Bot
    // does not hold is not in the record — there is nothing for the model to
    // call and nothing to wrap.
    const held = tool({ name: "mcp__held__search" });
    const record = createMastraTools([held]);
    expect(Object.keys(record)).toEqual(["mcp__held__search"]);
    expect(Object.hasOwn(record, "mcp__ungranted__delete_all")).toBe(false);
  });

  it("two_bindings_do_not_share_tools_or_prompt", () => {
    // Each binding wraps its own granted tools into its own per-call
    // instances: no cross-binding tool object, and (at the execution layer,
    // which builds one Agent per request) no shared prompt.
    const bindingA = tool({ name: "mcp__server__echo_tool" });
    const bindingB = tool({ name: "mcp__server__echo_tool" });
    const recordA = createMastraTools([bindingA]);
    const recordB = createMastraTools([bindingB]);
    expect(recordA.mcp__server__echo_tool).toBeDefined();
    expect(recordB.mcp__server__echo_tool).toBeDefined();
    expect(recordA.mcp__server__echo_tool).not.toBe(
      recordB.mcp__server__echo_tool,
    );
  });

  it("vendor_error_remains_untrusted", async () => {
    // The vendor's answer text is wrapped by the GRANTED path (vendorAnswer),
    // and the refusal marker is the deployment's own. The wrapper re-words
    // nothing: both envelopes pass through byte-for-byte, so the transcript's
    // unwrapping and the model's reading stay exactly the legacy semantics.
    const vendorError = `The vendor reported an error:\n${markUntrusted(
      "The caller does not have permission",
      "connector error",
    )}`;
    const errorTool = tool({ execute: async () => vendorError });
    const refusalTool = tool({
      name: "mcp__server__refusing_tool",
      execute: async () => "Refused. policy denied this call.",
    });
    const record = createMastraTools([errorTool, refusalTool]);
    const answered = await callTool(record.mcp__server__echo_tool, {
      value: "hi",
    });
    expect(answered).toBe(vendorError);
    const refused = await callTool(record.mcp__server__refusing_tool, {
      value: "hi",
    });
    expect(refused).toBe("Refused. policy denied this call.");
  });

  it("approval_wait_parks_on_the_engine_and_non_approval_waits_refuse_named", async () => {
    // OCR fix wave 3 (R3-1), superseded by ME10's F4: the governed granted
    // path catches the approvals gate's HeadlessToolSuspension and PARKS the
    // engine durably (the pinned engine's own `context.agent.suspend`, the
    // same surface the frontend bridge uses) — never falling into the
    // tool-error branch where stream-events would markUntrusted the wait
    // into a "vendor tool error" the model reads as a rejection. With no
    // park surface at all (no `context.agent`), the wait still fails closed
    // with the named refusal; a NON-approval wait (a question, whose drive
    // shape is a different contract) refuses by name even with a park
    // surface present.
    const parks: unknown[] = [];
    const suspending = tool({
      execute: async () => {
        throw new HeadlessToolSuspension("waiting for approval", {
          kind: "approval",
          approvalId: "approval-1",
        });
      },
    });
    const record = createMastraTools([suspending]);
    // The engine injects `context.agent` on every execute (its suspend
    // no-ops outside a run), so the direct call below parks exactly the way
    // an in-run call would, and the marker names the call.
    const parked = await callTool(record.mcp__server__echo_tool, {
      value: "hi",
    });
    expect(parked).toMatchObject({ waiting: true, kind: "approval" });
    void parks;

    // (The engine's createTool enriches any passed context.agent with its
    // own suspend surface, so "no park surface" is not reachable through
    // the mounted wrapper for an approval wait — the fail-closed branch is
    // the kind check below plus defense for exotic hosts.)

    // A non-approval wait never parks, marker or refusal laundering.
    const questioning = tool({
      execute: async () => {
        throw new HeadlessToolSuspension("waiting for the answer", {
          kind: "question",
          requestId: "q-1",
        });
      },
    });
    const questionRecord = createMastraTools([questioning]);
    let questionCaught: unknown;
    try {
      await callTool(questionRecord.mcp__server__echo_tool, { value: "hi" });
    } catch (error) {
      questionCaught = error;
    }
    expect(questionCaught).toBeInstanceOf(MastraToolRefusal);
    expect(String((questionCaught as Error).message)).toContain(
      "MASTRA_TOOL_SUSPENSION_UNSUPPORTED",
    );

    // Any other throw keeps the engine's tool-error semantics (markUntrusted
    // downstream): only the suspension is intercepted.
    const failing = tool({
      execute: async () => {
        throw new Error("vendor exploded");
      },
    });
    const failingRecord = createMastraTools([failing]);
    await expect(
      callTool(failingRecord.mcp__server__echo_tool, { value: "hi" }),
    ).rejects.toThrow("vendor exploded");
  });

  it("reserved_name_collision_refused", () => {
    // Duplicate model names: two grants claiming one name would silently let
    // the last mount override the first — refused instead.
    expect(() =>
      createMastraTools([
        tool({ name: "mcp__server__echo_tool" }),
        tool({ name: "mcp__server__echo_tool" }),
      ]),
    ).toThrow(/MASTRA_TOOL_NAME_COLLISION/);
    // Reserved system names (the learned-skill tools ME08 mounts itself)
    // can never be overridden by a grant.
    for (const reserved of [
      "copilotkit_load_skill",
      "copilotkit_read_skill_file",
    ]) {
      expect(() => createMastraTools([tool({ name: reserved })])).toThrow(
        /MASTRA_TOOL_NAME_RESERVED/,
      );
    }
    // Invalid tool names (empty, whitespace, path-ish, off-charset) are named
    // refusals, never silently mounted. Dots are NOT invalid any more — they
    // are MCP tool-name reality (the positive case below pins that).
    for (const invalid of ["", "has space", "../escape", "has:colon"]) {
      expect(() => createMastraTools([tool({ name: invalid })])).toThrow(
        /MASTRA_TOOL_NAME_INVALID/,
      );
    }
    // A dotted brokered name mounts: OpenConnector's action ids are dotted
    // (`github.get_current_user`), and the minted spelling carries the dot
    // (`mcp__open-connector-github__github.get_current_user`). The earlier
    // charset refused every real brokered grant (UP10 integration evidence).
    expect(() =>
      createMastraTools([
        tool({ name: "mcp__open-connector-github__github.get_current_user" }),
      ]),
    ).not.toThrow();
    // The length cap is 64: the OpenAI tool-name limit (the strictest
    // provider). Exactly 64 mounts; 65 would be refused at grant time first
    // (see grant_write_refuses... below), and the mount-time check stays as
    // defense in depth for grants written before that gate existed.
    expect(() =>
      createMastraTools([tool({ name: "a".repeat(64) })]),
    ).not.toThrow();
    expect(() => createMastraTools([tool({ name: "a".repeat(65) })])).toThrow(
      /MASTRA_TOOL_NAME_INVALID/,
    );
    // A malformed entry that is not a GrantedTool at all is refused, not
    // improvised.
    expect(() =>
      createMastraTools([
        { name: "mcp__server__half_tool" } as unknown as GrantedTool,
      ]),
    ).toThrow(/MASTRA_TOOL_UNKNOWN/);
  });

  it("grant_write_refuses_model_unaddressable_tool_names", async () => {
    // OCR fix wave 3 (R3-2): the model tool name is minted at the grant write
    // (toolNameFor, plugins/store.ts). A name no provider can address must
    // refuse THERE — one stored bad grant would otherwise fail every
    // Mastra-engine run of the Bot at mount, including pure-text turns that
    // never touch the tool. The rule is THE one shared constant, never a
    // second copy.
    let writeReached = false;
    const plugins = createPluginStore({
      database: {
        insert: () => {
          writeReached = true;
          throw new Error("the gate must refuse before any grant write");
        },
      } as never,
      auditStore: { insert: async () => undefined },
      credentials: {} as never,
      encryptionKey: "grant-name-gate-test",
      policy: () => ({}) as never,
    });
    // Overlong (the 64-char cap breached via server or tool half) and
    // charset violations both refuse with the named configuration error —
    // before the database sees anything.
    for (const badRef of [
      `server/${"a".repeat(60)}`,
      "server/has space",
      "server/has:colon",
    ]) {
      await expect(
        plugins.grant("mcp", badRef, "bot-1", "admin@example.com"),
      ).rejects.toThrow(/GRANT_TOOL_NAME_INVALID/);
    }
    expect(writeReached).toBe(false);
    // An addressable grant passes the gate: the fake write is the next thing
    // that runs (its throw proves the gate let the grant through).
    await expect(
      plugins.grant("mcp", "server/ok_tool", "bot-1", "admin@example.com"),
    ).rejects.toThrow(/gate must refuse before any grant write/);
    // A real brokered ref is addressable too: the dotted action id
    // OpenConnector publishes mints
    // `mcp__open-connector-github__github.get_current_user`, which passes the
    // gate and reaches the write — refusing it was the UP10 evidence break.
    await expect(
      plugins.grant(
        "mcp",
        "open-connector-github/github.get_current_user",
        "bot-1",
        "admin@example.com",
      ),
    ).rejects.toThrow(/gate must refuse before any grant write/);
    // Skill and bot grants are not model tool names: they skip the gate.
    await expect(
      plugins.grant(
        "skill",
        "a-skill/with:oddities",
        "bot-1",
        "admin@example.com",
      ),
    ).rejects.toThrow(/gate must refuse before any grant write/);
    // The mount-time check and the grant-time gate enforce the SAME rule.
    expect(VALID_TOOL_NAME.source).toBe("^[A-Za-z0-9._-]{1,64}$");
    // F16-2: the CLIENT-declared bridge charset is a deliberate SECOND rule.
    // The AG-UI tool list is per-request third-party input, so a name outside
    // the wire-safe charset is dropped at mount there (fail-soft) instead of
    // being mounted and colliding with a legal sibling after the engine's
    // formatTools rewrite (AGENT_TOOL_NAME_COLLISION kills the whole run).
    // This pins the split in both directions: what the bridge refuses on the
    // wire is what the brokered / granted configuration path above still
    // admits.
    expect(VALID_BRIDGE_TOOL_NAME.source).toBe("^[A-Za-z0-9_-]{1,64}$");
    expect(VALID_BRIDGE_TOOL_NAME.test("github.get_current_user")).toBe(false);
    expect(VALID_BRIDGE_TOOL_NAME.test("mcp__server__echo_tool")).toBe(true);
    expect(VALID_TOOL_NAME.test("github.get_current_user")).toBe(true);
  });
});
