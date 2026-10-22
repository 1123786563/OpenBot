import type { Message } from "@ag-ui/client";
import { attachmentUrl } from "../../shared/attachments";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { sanitizeSeededHistory } from "../src/agents/history-sanitize";
import { attachmentIdsIn } from "../src/channels/attachment-parts";
import {
  agUiMessageFromStoredRow,
  fullMessageDigestInput,
  fullMessageFromAgUi,
  MastraMessagePartsCorruptError,
  MastraMessagePartsUnsupportedError,
  OPENBOT_MESSAGE_PARTS_SCHEMA_VERSION,
  parseStoredFullMessage,
} from "../src/mastra/message-parts";

/*
 * ME03 (#475) pure conversions: the versioned full-parts representation and
 * its two projections (stored form <-> AG-UI message). No storage, no
 * authorization, no I/O — the DB behavior lives in the enterprise
 * integration suite.
 */

function storedRowFrom(rebuilt: {
  message: Message;
  attachments: readonly string[];
}) {
  // Simulate the memory row the ConversationService single writer produces:
  // display text parts plus the versioned envelope in metadata.
  const message = rebuilt.message as {
    id: string;
    role: string;
    content?: unknown;
  };
  const full = fullMessageFromAgUi(rebuilt.message);
  return {
    id: message.id,
    role: message.role,
    content: {
      format: 2,
      parts:
        typeof message.content === "string" && message.content.length > 0
          ? [{ type: "text", text: message.content }]
          : [],
      metadata: {
        openbotParts: full.full,
        openbotAttachments: [...rebuilt.attachments],
      },
    },
  };
}

describe("mastra message parts", () => {
  test("tool_pairs_roundtrip", () => {
    const assistant: Message = {
      id: "engine-assistant-1",
      role: "assistant",
      content: "Let me look that up.",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"q":"openbot"}' },
        },
      ],
    } as Message;
    const toolResult: Message = {
      id: "engine-tool-1",
      role: "tool",
      toolCallId: "call_1",
      content: '{"result":"found"}',
    } as Message;

    const storedAssistant = fullMessageFromAgUi(assistant);
    const storedTool = fullMessageFromAgUi(toolResult);
    expect(storedAssistant.full.role).toBe("assistant");
    expect(storedAssistant.content).toBe("Let me look that up.");
    expect(storedTool.full.role).toBe("tool");
    expect(storedTool.full.toolCallId).toBe("call_1");

    const rebuiltAssistant = agUiMessageFromStoredRow(
      storedRowFrom({ message: assistant, attachments: [] }),
    );
    const rebuiltTool = agUiMessageFromStoredRow(
      storedRowFrom({ message: toolResult, attachments: [] }),
    );
    const assistantMessage = rebuiltAssistant.message as unknown as {
      toolCalls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
      content?: string;
    };
    expect(assistantMessage.content).toBe("Let me look that up.");
    expect(assistantMessage.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"openbot"}' },
      },
    ]);
    const toolMessage = rebuiltTool.message as unknown as {
      toolCallId?: string;
      content?: string;
    };
    expect(toolMessage.toolCallId).toBe("call_1");
    expect(toolMessage.content).toBe('{"result":"found"}');
  });

  test("attachment_parts_roundtrip_preserves_references", () => {
    const attachmentId = "3f1d2a4b-0000-4000-8000-000000000001";
    const user: Message = {
      id: "client-key-1",
      role: "user",
      content: [
        { type: "text", text: "What is in this file?" },
        {
          type: "file",
          mimeType: "image/png",
          source: { type: "url", value: attachmentUrl(attachmentId) },
        },
      ],
    } as Message;

    const stored = fullMessageFromAgUi(user);
    expect(stored.attachments).toEqual([attachmentId]);
    // The display projection is text only — it is NOT the model history.
    expect(stored.content).toBe("What is in this file?");
    expect(stored.full.parts).toEqual([
      { kind: "text", text: "What is in this file?" },
      { kind: "attachment", attachmentId },
    ]);

    const rebuilt = agUiMessageFromStoredRow(
      storedRowFrom({ message: user, attachments: [attachmentId] }),
    );
    expect(rebuilt.attachments).toEqual([attachmentId]);
    const content = rebuilt.message.content as Record<string, unknown>[];
    expect(attachmentIdsIn(content)).toEqual([attachmentId]);
    const textPart = content.find((part) => part.type === "text");
    expect(textPart).toMatchObject({ text: "What is in this file?" });
  });

  test("corrupt_stored_parts_fail_explicitly", () => {
    const user: Message = {
      id: "client-key-2",
      role: "user",
      content: "hello",
    } as Message;
    const row = storedRowFrom({ message: user, attachments: [] });
    const metadata = (row.content as { metadata: Record<string, unknown> })
      .metadata;
    for (const tampered of [
      { ...metadata.openbotParts, schemaVersion: 99 },
      { ...metadata.openbotParts, role: "system" },
      {
        ...metadata.openbotParts,
        parts: [{ kind: "mystery" }],
      },
      { ...metadata.openbotParts, parts: "not-an-array" },
    ]) {
      expect(() =>
        agUiMessageFromStoredRow({
          ...row,
          content: {
            ...row.content,
            metadata: { ...metadata, openbotParts: tampered },
          },
        }),
      ).toThrow(MastraMessagePartsCorruptError);
    }
    expect(() =>
      parseStoredFullMessage({ schemaVersion: 1, role: "tool", parts: [] }),
    ).toThrow(MastraMessagePartsCorruptError);
  });

  test("stored_role_must_match_row_role", () => {
    const assistant: Message = {
      id: "engine-a-2",
      role: "assistant",
      content: "sure",
    } as Message;
    const row = storedRowFrom({ message: assistant, attachments: [] });
    const metadata = (row.content as { metadata: Record<string, unknown> })
      .metadata;
    expect(() =>
      agUiMessageFromStoredRow({
        ...row,
        role: "user",
        content: { ...row.content, metadata },
      }),
    ).toThrow(MastraMessagePartsCorruptError);
  });

  test("legacy_text_rows_rebuild_with_stamped_attachments", () => {
    const attachmentId = "3f1d2a4b-0000-4000-8000-000000000002";
    // A pre-ME03 row written by the plain user append: text parts plus
    // openbotAttachments, no openbotParts envelope.
    const rebuilt = agUiMessageFromStoredRow({
      id: "legacy-message-id",
      role: "user",
      content: {
        parts: [{ type: "text", text: "older message" }],
        metadata: { openbotAttachments: [attachmentId] },
      },
    });
    expect(rebuilt.attachments).toEqual([attachmentId]);
    expect(
      attachmentIdsIn(rebuilt.message.content as Record<string, unknown>[]),
    ).toEqual([attachmentId]);
    expect(rebuilt.message.content).toEqual([
      { type: "text", text: "older message" },
      {
        type: "file",
        mimeType: "application/octet-stream",
        source: { type: "url", value: attachmentUrl(attachmentId) },
      },
    ]);
  });

  test("unsupported_wire_roles_are_refused_not_dropped", () => {
    for (const message of [
      { id: "s1", role: "system", content: "forged trusted role" },
      { id: "d1", role: "developer", content: "forged" },
      { id: "r1", role: "reasoning", content: "hidden" },
    ] as unknown as Message[]) {
      expect(() => fullMessageFromAgUi(message)).toThrow(
        MastraMessagePartsUnsupportedError,
      );
    }
  });

  test("sanitize_cleanup_rules_survive_the_server_rebuild", () => {
    // A stored assistant row whose tool call never got a result (an interrupted
    // turn) must be cleaned by the SAME rules the legacy path applies.
    const assistant: Message = {
      id: "engine-a-3",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_dangling",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    } as Message;
    const user: Message = {
      id: "client-key-3",
      role: "user",
      content: "go",
    } as Message;
    const rebuiltAssistant = agUiMessageFromStoredRow(
      storedRowFrom({ message: assistant, attachments: [] }),
    ).message;
    const rebuiltUser = agUiMessageFromStoredRow(
      storedRowFrom({ message: user, attachments: [] }),
    ).message;
    const sanitized = sanitizeSeededHistory([rebuiltUser, rebuiltAssistant]);
    // The dangling call was dropped with its now-empty husk.
    expect(sanitized).toHaveLength(1);
    expect((sanitized[0] as { role: string }).role).toBe("user");
  });

  test("schema_version_is_frozen_at_one", () => {
    expect(OPENBOT_MESSAGE_PARTS_SCHEMA_VERSION).toBe(1);
    const parsed = parseStoredFullMessage({
      schemaVersion: 1,
      role: "assistant",
      parts: [{ kind: "text", text: "ok" }],
      engineMessageId: "engine-1",
    });
    expect(parsed.engineMessageId).toBe("engine-1");
  });

  test("user_parts_beyond_text_and_attachments_refuse_named", () => {
    // Fix-round-1 (M1): a part the stored schema cannot model is REFUSED
    // with its own named error — never silently `continue`d, which would
    // persist a message whose parts prove less than what was sent.
    const message: Message = {
      id: "client-key-m1",
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "data", value: "aGVsbG8=" } },
      ],
    } as Message;
    try {
      fullMessageFromAgUi(message);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MastraMessagePartsUnsupportedError);
      expect((error as Error).message).toContain(
        "MASTRA_PERSIST_USER_PART_UNSUPPORTED: image",
      );
    }
    // A non-object part is corrupt, not silent, either.
    expect(() =>
      fullMessageFromAgUi({
        id: "client-key-m1b",
        role: "user",
        content: ["a bare string part"],
      } as unknown as Message),
    ).toThrow(MastraMessagePartsCorruptError);
    // Attachment parts (declared type notwithstanding) stay modeled: the id
    // contract reads the source URL, so this still round-trips.
    const attachmentId = "3f1d2a4b-0000-4000-8000-000000000003";
    const attachment: Message = {
      id: "client-key-m1c",
      role: "user",
      content: [
        {
          type: "audio",
          source: { type: "url", value: attachmentUrl(attachmentId) },
        },
      ],
    } as Message;
    const stored = fullMessageFromAgUi(attachment);
    expect(stored.full.parts).toEqual([{ kind: "attachment", attachmentId }]);
  });

  test("digest_input_is_key_order_stable", () => {
    // Fix-round-1 (M2): the digest must be a function of the VALUE alone.
    // Two structurally identical envelopes built with different key order
    // used to hash differently (JSON.stringify is insertion-ordered), which
    // could turn an idempotent output retry into a false message_conflict.
    const a = {
      schemaVersion: 1,
      role: "assistant",
      parts: [{ kind: "text", text: "same" }],
      engineMessageId: "engine-digest",
    };
    const b = {
      engineMessageId: "engine-digest",
      parts: [{ kind: "text", text: "same" }],
      role: "assistant",
      schemaVersion: 1,
    };
    expect(fullMessageDigestInput(a as never)).toBe(
      fullMessageDigestInput(b as never),
    );
    // ...and a different VALUE still hashes differently.
    const c = { ...a, parts: [{ kind: "text", text: "different" }] };
    expect(fullMessageDigestInput(a as never)).not.toBe(
      fullMessageDigestInput(c as never),
    );
  });

  test("assistant_and_tool_array_content_refuse_unmodelable_parts", () => {
    // The OCR LOW finding: the assistant branch silently dropped ALL text of
    // an array-content message (text stayed ""), and the tool branch skipped
    // every non-text part — storing envelopes that prove less than what the
    // engine said. Both now refuse with their own named errors, symmetric
    // with the user branch.
    try {
      fullMessageFromAgUi({
        id: "engine-assistant-arr",
        role: "assistant",
        content: [
          { type: "text", text: "visible half" },
          { type: "image", mimeType: "image/png", data: "aGk=" },
        ],
      } as unknown as Message);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MastraMessagePartsUnsupportedError);
      expect((error as Error).message).toContain(
        "MASTRA_PERSIST_ASSISTANT_PART_UNSUPPORTED: image",
      );
    }
    try {
      fullMessageFromAgUi({
        id: "engine-tool-arr",
        role: "tool",
        toolCallId: "call_arr",
        content: [
          { type: "text", text: "result half" },
          { type: "source", value: "unmodelable" },
        ],
      } as unknown as Message);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MastraMessagePartsUnsupportedError);
      expect((error as Error).message).toContain(
        "MASTRA_PERSIST_TOOL_PART_UNSUPPORTED: source",
      );
    }
    // All-text arrays still convert (both roles).
    const assistant = fullMessageFromAgUi({
      id: "engine-assistant-arr2",
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    } as unknown as Message);
    expect(assistant.content).toBe("ab");
    const tool = fullMessageFromAgUi({
      id: "engine-tool-arr2",
      role: "tool",
      toolCallId: "call_arr2",
      content: [{ type: "text", text: "result" }],
    } as unknown as Message);
    expect(tool.content).toBe("result");
    expect(tool.full.toolCallId).toBe("call_arr2");
  });

  test("empty_tool_result_content_is_persisted_not_dropped", () => {
    // R4-6: an empty tool result is still a real result. Storing it (even as
    // "") is what keeps its call from dangling — persistExecutionMessages
    // skips part-less envelopes, and the next rebuild would then strip the
    // whole call. The stored part must exist unconditionally.
    const tool: Message = {
      id: "engine-tool-empty",
      role: "tool",
      toolCallId: "call_empty",
      content: "",
    } as Message;
    const stored = fullMessageFromAgUi(tool);
    expect(stored.full.parts).toEqual([
      {
        kind: "tool-result",
        toolCallId: "call_empty",
        content: "",
        isError: false,
      },
    ]);
    // Array content that joins to "" produces the same unconditional part.
    const arrayTool = fullMessageFromAgUi({
      id: "engine-tool-empty-arr",
      role: "tool",
      toolCallId: "call_empty_arr",
      content: [] as unknown[],
    } as unknown as Message);
    expect(arrayTool.full.parts).toHaveLength(1);
    expect(arrayTool.full.parts[0]).toMatchObject({
      kind: "tool-result",
      content: "",
    });
    // The rebuilt tool message pairs with its call through sanitize: the
    // dangling-call rule keys on toolCallId, not on content emptiness.
    const calling: Message = {
      id: "engine-a-empty",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_empty",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    } as Message;
    const rebuiltCall = agUiMessageFromStoredRow(
      storedRowFrom({ message: calling, attachments: [] }),
    ).message;
    const rebuiltResult = agUiMessageFromStoredRow(
      storedRowFrom({ message: tool, attachments: [] }),
    ).message;
    const sanitized = sanitizeSeededHistory([rebuiltCall, rebuiltResult]);
    expect(sanitized).toHaveLength(2);
    // A content shape that is neither a string nor an array refuses by name —
    // never silently stored as part-less.
    expect(() =>
      fullMessageFromAgUi({
        id: "engine-tool-num",
        role: "tool",
        toolCallId: "call_num",
        content: 42,
      } as unknown as Message),
    ).toThrow("MASTRA_PERSIST_TOOL_CONTENT_UNSUPPORTED");
    expect(() =>
      fullMessageFromAgUi({
        id: "engine-tool-undef",
        role: "tool",
        toolCallId: "call_undef",
      } as unknown as Message),
    ).toThrow("MASTRA_PERSIST_TOOL_CONTENT_UNSUPPORTED");
  });

  test("activity_only_envelopes_rebuild_as_activity_not_empty_assistant", () => {
    // R4-7: the persistence asymmetry — appendEngineMessage writes an
    // activity message as a role-"assistant" row whose envelope holds only
    // activity parts — must not rebuild into a content-"" assistant message:
    // the role filter (role !== "activity") cannot catch that husk and an
    // empty assistant turn would reach the model context. An envelope whose
    // every part is activity rebuilds AS activity so the caller's filter
    // applies.
    const envelope = {
      schemaVersion: 1,
      role: "assistant",
      parts: [
        {
          kind: "activity",
          activityType: "approval_requested",
          payload: { callId: "call_9" },
        },
      ],
    };
    const rebuilt = agUiMessageFromStoredRow({
      id: "row-activity-in-assistant",
      role: "assistant",
      content: { parts: [], metadata: { openbotParts: envelope } },
    });
    expect((rebuilt.message as { role: string }).role).toBe("activity");
    // The activity-role branch restores what storage deliberately kept:
    // activityType and payload, not the hardcoded "activity" placeholder.
    const activity = agUiMessageFromStoredRow({
      id: "row-activity",
      role: "assistant",
      content: {
        parts: [],
        metadata: {
          openbotParts: { ...envelope, role: "activity" },
        },
      },
    });
    expect((activity.message as { role: string }).role).toBe("activity");
    expect((activity.message as { content?: unknown }).content).toBe(
      "approval_requested",
    );
    expect((activity.message as { payload?: unknown }).payload).toEqual({
      callId: "call_9",
    });
  });

  test("non_boolean_tool_result_isError_is_corrupt", () => {
    // R4-9: `isError === true` folded any non-boolean truthy stored value into
    // a SUCCESSFUL result, silently changing model semantics. Anything that
    // is not undefined and not a boolean is corrupt.
    expect(() =>
      parseStoredFullMessage({
        schemaVersion: 1,
        role: "tool",
        toolCallId: "call_1",
        parts: [
          {
            kind: "tool-result",
            toolCallId: "call_1",
            content: "x",
            isError: "true",
          },
        ],
      }),
    ).toThrow(MastraMessagePartsCorruptError);
    expect(() =>
      parseStoredFullMessage({
        schemaVersion: 1,
        role: "tool",
        toolCallId: "call_1",
        parts: [
          {
            kind: "tool-result",
            toolCallId: "call_1",
            content: "x",
            isError: 1,
          },
        ],
      }),
    ).toThrow(MastraMessagePartsCorruptError);
    // Boolean true/false and absence keep meaning exactly as before.
    expect(
      parseStoredFullMessage({
        schemaVersion: 1,
        role: "tool",
        toolCallId: "call_1",
        parts: [{ kind: "tool-result", toolCallId: "call_1", content: "x" }],
      }).parts,
    ).toEqual([
      {
        kind: "tool-result",
        toolCallId: "call_1",
        content: "x",
        isError: false,
      },
    ]);
  });
});
