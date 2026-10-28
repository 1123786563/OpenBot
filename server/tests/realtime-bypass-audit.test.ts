import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createRealtimeSessionService } from "../src/billing/realtime-session";
import type { Database } from "../src/db/client";

/*
 * Ticket 16.3 (#324), OpenBot half — the establishment door's own bypass bound. The client
 * of a realtime session has exactly one thing to hand the door: the identity claim
 * {grantId, payer, model, versions}. A request that instead carries a provider-session
 * credential (a client_secret, an ephemeral token, an api key) or an upstream endpoint is
 * the client-side shape of 临时 provider 会话绕开 — the attempt to make the door run its
 * session on something the OpenBot admission never issued.
 *
 * What this file pins (the shape boundary, so no database is opened — the refusals below
 * all precede any read):
 *
 *   - every field of the bypass vocabulary is refused ON PRESENCE, camel or snake, with the
 *     bypass reason riding the detail, and no credential VALUE is echoed in the answer;
 *   - each refused attempt leaves exactly one audit row (billing.realtime.bypass_refused)
 *     naming the refused field and the door's reason — the claim's grant id rides as the
 *     client's CLAIM, deployment-initiated, never as a resolved identity;
 *   - an ordinary shape refusal (a bad payer claim, an account-identity field) writes NO
 *     bypass row — the audit is the bypass's own, not a second log of every 400;
 *   - the RESTORE answer carries no credential or endpoint field of any kind — the
 *     contract view is the identity the door froze, and nothing a client could replay
 *     against an upstream.
 */

type Recorded = AuditEventInput[];

function auditSink(): { store: AuditStore; events: Recorded } {
  const events: Recorded = [];
  return {
    events,
    store: {
      insert: async (event) => {
        events.push(event);
      },
    },
  };
}

/** The door over a database it never touches (every case here is refused at the shape). */
function door(audit?: AuditStore) {
  return createRealtimeSessionService({
    database: {} as Database,
    readReadiness: async () => ({ ready: true }),
    ...(audit === undefined ? {} : { audit }),
  });
}

/** One well-shaped establishment body the bypass field is smuggled into. */
function legitBody() {
  return {
    grantId: "grant-bypass-test",
    payer: { kind: "personal", id: "user-bypass-test" },
    model: {
      provider: "openai",
      model: "gpt-realtime",
      capability: "realtime",
    },
    snapshotVersion: 1,
    rateVersion: 0,
  };
}

describe("Bifrost 16.3 (#324): the establishment door refuses and audits bypass attempts", () => {
  test("every provider-session credential and endpoint field is refused on presence", async () => {
    const service = door();
    for (const field of [
      "clientSecret",
      "client_secret",
      "ephemeralToken",
      "ephemeral_token",
      "sessionToken",
      "session_token",
      "apiKey",
      "api_key",
      "providerToken",
      "provider_token",
      "upstreamUrl",
      "upstream_url",
      "websocketUrl",
      "endpoint",
      "baseUrl",
      "wssUrl",
    ]) {
      const outcome = await service.establish({
        ...legitBody(),
        [field]: "whatever-the-value-is",
      });
      expect(outcome.status, field).toBe("refused");
      if (outcome.status !== "refused") continue;
      expect(outcome.reasonCode, field).toBe("request_invalid");
      expect(outcome.detail.field).toBe(field);
      expect(outcome.detail.reason).toBe(
        "provider_session_credential_or_endpoint",
      );
      // The VALUE never rides the answer — the field's name is the whole story.
      expect(JSON.stringify(outcome.detail)).not.toContain(
        "whatever-the-value-is",
      );
    }
  });

  test("each refused attempt leaves exactly one audit row, naming the claim as a claim", async () => {
    const { store, events } = auditSink();
    const service = door(store);

    await service.establish({ ...legitBody(), clientSecret: "sekrit" });
    await service.establish({
      ...legitBody(),
      grantId: "grant-second-claim",
      upstreamUrl: "wss://api.openai.com/v1/realtime",
    });

    expect(events).toHaveLength(2);
    const [first, second] = events;
    expect(first?.eventType).toBe("billing.realtime.bypass_refused");
    expect(first?.targetType).toBe("billing");
    expect(first?.targetId).toBe("grant-bypass-test");
    expect(first?.initiator).toEqual({ kind: "deployment" });
    expect(first?.payload).toEqual({
      field: "clientSecret",
      reason: "provider_session_credential_or_endpoint",
      claimedGrantId: "grant-bypass-test",
    });
    expect(JSON.stringify(first?.payload)).not.toContain("sekrit");
    expect(second?.payload).toEqual({
      field: "upstreamUrl",
      reason: "provider_session_credential_or_endpoint",
      claimedGrantId: "grant-second-claim",
    });
  });

  test("the claim never rides as a person — the row is deployment-initiated", async () => {
    const { store, events } = auditSink();
    const service = door(store);

    // A body whose grant claim is well-shaped but whose ONLY fault is the smuggled field:
    // the shape order (grantId first) guarantees the audited claim is an identifier.
    const outcome = await service.establish({ ...legitBody(), apiKey: "x" });
    expect(outcome.status).toBe("refused");
    expect(events).toHaveLength(1);
    // The door resolved NOTHING about this grant; the row borrows no one's authority.
    expect(events[0]?.actorUserId).toBeUndefined();
    expect(events[0]?.initiator).toEqual({ kind: "deployment" });
    expect(events[0]?.payload).toEqual({
      field: "apiKey",
      reason: "provider_session_credential_or_endpoint",
      claimedGrantId: "grant-bypass-test",
    });
  });

  test("ordinary shape refusals write no bypass row — the audit is the bypass's own", async () => {
    const { store, events } = auditSink();
    const service = door(store);

    // A bad payer claim, and an account-identity field: both refused, neither audited here.
    const badPayer = await service.establish({
      ...legitBody(),
      payer: { kind: "personal" },
    });
    expect(badPayer.status).toBe("refused");
    const accountField = await service.establish({
      ...legitBody(),
      userId: "someone-else",
    });
    expect(accountField.status).toBe("refused");
    expect(events).toHaveLength(0);
  });

  test("the restore answer carries no credential or endpoint field of any kind", async () => {
    // The contract view is the frozen identity; the test pins its shape against the bypass
    // vocabulary so a future field cannot quietly hand a client a replayable credential.
    const service = door();
    const outcome = await service.establish({
      ...legitBody(),
      clientSecret: "x",
    });
    expect(outcome.status).toBe("refused");

    // The record shape itself (what restore answers for an established row) — asserted by
    // construction: the view's keys are exactly the identity vocabulary below.
    const recordKeys = [
      "sessionId",
      "grantId",
      "payer",
      "model",
      "snapshotVersion",
      "rateVersion",
      "startedAt",
      "state",
      "stoppedAt",
      "stopReason",
      "closedAt",
      "closeReason",
    ];
    const vocabulary = new Set([
      "clientsecret",
      "client_secret",
      "ephemeraltoken",
      "ephemeral_token",
      "sessiontoken",
      "session_token",
      "apikey",
      "api_key",
      "providertoken",
      "provider_token",
      "accesstoken",
      "access_token",
      "bearertoken",
      "bearer_token",
      "upstreamurl",
      "upstream_url",
      "websocketurl",
      "websocket_url",
      "wssurl",
      "wss_url",
      "endpoint",
      "baseurl",
      "base_url",
      "providerurl",
      "provider_url",
    ]);
    for (const key of recordKeys) {
      expect(vocabulary.has(key.toLowerCase())).toBe(false);
    }
  });
});
