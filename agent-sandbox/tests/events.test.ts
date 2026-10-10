import { describe, expect, test } from "bun:test";
import {
  SANDBOX_EVENT_TYPES,
  familyOf,
  parseSandboxEvent,
} from "../src/events";

/** The captured samples, verbatim modulo id/path redaction — docs/sse-samples.md holds them. */
const SAMPLES = {
  serverConnected:
    '{"id":"evt_1","type":"server.connected","properties":{}}',
  heartbeat: '{"id":"evt_2","type":"server.heartbeat","properties":{}}',
  partDelta:
    '{"id":"evt_3","type":"message.part.delta","properties":{"sessionID":"ses_S","messageID":"msg_S","partID":"prt_S","field":"text","delta":"2+2 等于 4。"}}',
  partUpdatedStepStart:
    '{"id":"evt_4","type":"message.part.updated","properties":{"sessionID":"ses_S","part":{"id":"prt_S2","messageID":"msg_S","sessionID":"ses_S","type":"step-start"},"time":1791658187844}}',
  partUpdatedTool:
    '{"id":"evt_5","type":"message.part.updated","properties":{"sessionID":"ses_S","part":{"id":"prt_S3","messageID":"msg_S","sessionID":"ses_S","type":"tool","tool":"bash","callID":"call_S","state":{"status":"pending","input":{},"raw":""}},"time":1791658188945}}',
  partUpdatedReasoning:
    '{"id":"evt_6","type":"message.part.updated","properties":{"sessionID":"ses_S","part":{"id":"prt_S4","messageID":"msg_S","sessionID":"ses_S","type":"reasoning","text":"先算加法"},"time":1791658189000}}',
  messageUpdated:
    '{"id":"evt_7","type":"message.updated","properties":{"sessionID":"ses_S","info":{"id":"msg_S2","role":"user","sessionID":"ses_S","time":{"created":1791658183753},"agent":"build"}}}',
  sessionStatus:
    '{"id":"evt_8","type":"session.status","properties":{"sessionID":"ses_S","status":{"type":"busy"}}}',
  sessionIdle:
    '{"id":"evt_9","type":"session.idle","properties":{"sessionID":"ses_S"}}',
  fileEdited:
    '{"id":"evt_10","type":"file.edited","properties":{"file":"/workspace/bots/bot/write_csv.py"}}',
  pluginAdded: '{"id":"evt_11","type":"plugin.added","properties":{"id":"xai"}}',
};

describe("SANDBOX_EVENT_TYPES", () => {
  test("carries every type the capture observed", () => {
    for (const type of [
      "message.updated",
      "message.part.updated",
      "message.part.delta",
      "session.updated",
      "session.status",
      "session.diff",
      "session.idle",
      "server.connected",
      "server.heartbeat",
      "file.edited",
      "file.watcher.updated",
      "plugin.added",
      "catalog.updated",
      "reference.updated",
      "integration.updated",
    ]) {
      expect(SANDBOX_EVENT_TYPES).toContain(type);
    }
  });
});

describe("parseSandboxEvent", () => {
  test("parses a message.part.delta with its delta text", () => {
    const event = parseSandboxEvent(SAMPLES.partDelta);
    expect(event.type).toBe("message.part.delta");
    if (event.type === "message.part.delta") {
      expect(event.delta).toBe("2+2 等于 4。");
      expect(event.field).toBe("text");
      expect(event.partID).toBe("prt_S");
    }
  });

  test("parses a tool part with tool name and state", () => {
    const event = parseSandboxEvent(SAMPLES.partUpdatedTool);
    expect(event.type).toBe("message.part.updated");
    if (event.type === "message.part.updated") {
      expect(event.part.type).toBe("tool");
      expect(event.part.tool).toBe("bash");
      expect(event.part.state?.status).toBe("pending");
    }
  });

  test("parses session.status with its status type", () => {
    const event = parseSandboxEvent(SAMPLES.sessionStatus);
    if (event.type === "session.status") {
      expect(event.status).toBe("busy");
      expect(event.sessionID).toBe("ses_S");
    } else {
      throw new Error("expected session.status");
    }
  });

  test("an unparseable line becomes unknown, not a throw", () => {
    expect(parseSandboxEvent("not json at all").type).toBe("unknown");
    expect(parseSandboxEvent("42").type).toBe("unknown");
    expect(parseSandboxEvent("null").type).toBe("unknown");
  });

  test("a type this version has never seen becomes unknown, not a throw", () => {
    const future = JSON.stringify({
      id: "evt_x",
      type: "subagent.spawned",
      properties: { anything: true },
    });
    const event = parseSandboxEvent(future);
    expect(event.type).toBe("unknown");
    // The payload survives, so a later version can add the type without losing the data.
    expect((event as { raw: { type: string } }).raw.type).toBe("subagent.spawned");
  });

  test("every captured sample parses without throwing", () => {
    for (const sample of Object.values(SAMPLES)) {
      expect(() => parseSandboxEvent(sample)).not.toThrow();
    }
  });
});

describe("familyOf — the five product families from the capture", () => {
  test("text deltas are message_chunk", () => {
    expect(familyOf(parseSandboxEvent(SAMPLES.partDelta))).toBe("message_chunk");
  });

  test("reasoning parts are thought; tool parts are tool_call", () => {
    expect(familyOf(parseSandboxEvent(SAMPLES.partUpdatedReasoning))).toBe(
      "thought",
    );
    expect(familyOf(parseSandboxEvent(SAMPLES.partUpdatedTool))).toBe(
      "tool_call",
    );
  });

  test("session.status is progress; session.idle is prompt_response", () => {
    expect(familyOf(parseSandboxEvent(SAMPLES.sessionStatus))).toBe("progress");
    expect(familyOf(parseSandboxEvent(SAMPLES.sessionIdle))).toBe(
      "prompt_response",
    );
  });

  test("heartbeats, plugins and unknowns are other", () => {
    expect(familyOf(parseSandboxEvent(SAMPLES.heartbeat))).toBe("other");
    expect(familyOf(parseSandboxEvent(SAMPLES.pluginAdded))).toBe("other");
    expect(familyOf(parseSandboxEvent('{"type":"future.thing"}'))).toBe(
      "other",
    );
  });
});
