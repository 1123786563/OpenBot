// server/tests/multitenancy/telemetry-usage.test.ts
// MT109（Issue #152）：用量事件的账户区分与脱敏回归。
//
// 验收事实源（Issue #152 四条，逐条对应 describe）：
//   AC1 用量事件携带付款账户类型与稳定标识；公司与个人事件不混淆——
//      类型闭集、无字符串推断路径、同 id 跨类型不碰撞。
//   AC2 重放同一事件不会记到另一账户——幂等账本：同账户重放零二次写入，
//      异账户重放拒绝且零写入。
//   AC3 脱敏规则覆盖服务 token、cookie、OAuth、个人 Key 与凭据正文，含
//      错误与异常路径——本轮把 cookie 与 OAuth query 两族形状补进共享
//      scrubCommand（telemetry/scrub.ts），本套件钉住票面点名的每个向量。
//   AC4 既有脱敏回归套件全部通过——enterprise-controls.test.ts 的
//      scrubCommand 回归表（65 例）与 otel-export-scrubbing.test.ts（2 例）
//      在本票增量之后全绿，证据在 .archive/runs/<run-key>/verification/。
//
// 复跑：bun test server/tests/multitenancy/telemetry-usage.test.ts
// 既有套件：bunx e2e run --config e2e.unit.config.ts
//   server/tests/enterprise-controls.test.ts（e2e 原生层；bun 直跑
//   registerHooks 报错为存量属性）
// bun test server/tests/otel-export-scrubbing.test.ts

import { describe, expect, test } from "../../../tests/support/bun-test-compat";
import { scrubCommand } from "../../src/telemetry/scrub";
import {
  bindUsageEventAccount,
  createUsageEventRecorder,
  quarantineUsageEventAccount,
  redactUsageEvent,
  usageEventAccountStamp,
  USAGE_EVENT_ACCOUNT_INVALID,
  type UsageEvent,
  type UsageEventSink,
} from "../../src/enterprise/tenancy/telemetry-usage";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const COMPANY_ACCOUNT = bindUsageEventAccount({
  kind: "company",
  payerId: "tenant-acme",
  externalCustomerId: "openbot-company-tenant-acme",
});

const PERSONAL_ACCOUNT = bindUsageEventAccount({
  kind: "personal",
  payerId: "user-1",
  externalCustomerId: "openbot-personal-user-1",
});

function usageEvent(
  eventId: string,
  account: UsageEvent["account"],
  extra: Partial<UsageEvent> = {},
): UsageEvent {
  return {
    eventId,
    source: "llm",
    account,
    meters: [{ name: "output_tokens", value: 120 }],
    occurredAt: new Date("2026-10-22T00:00:00Z").toISOString(),
    ...extra,
  };
}

/** 记录型 sink：断言写了几次、写了什么。 */
function recordingSink(): UsageEventSink & { written: UsageEvent[] } {
  const written: UsageEvent[] = [];
  return { written, write: (event) => void written.push(event) };
}

// ---------------------------------------------------------------------------
// AC1：账户类型与稳定标识；公司与个人不混淆
// ---------------------------------------------------------------------------

describe("MT109 AC1 usage events carry the payment account's kind and stable identity", () => {
  test("the binding names kind, payer and the billing stack's own stable key", () => {
    expect(COMPANY_ACCOUNT).toEqual({
      kind: "company",
      payerId: "tenant-acme",
      externalCustomerId: "openbot-company-tenant-acme",
    });
    expect(PERSONAL_ACCOUNT.kind).toBe("personal");
  });

  test("company and personal never collide — not even on equal subject ids", () => {
    // 同一字符串当两类主体的 id：账户戳仍然互不相同（类型在戳里，键前缀在
    // payer 层就分开了——不混淆是结构性的）。
    const company = bindUsageEventAccount({
      kind: "company",
      payerId: "usr_1",
      externalCustomerId: "openbot-company-usr_1",
    });
    const personal = bindUsageEventAccount({
      kind: "personal",
      payerId: "usr_1",
      externalCustomerId: "openbot-personal-usr_1",
    });
    expect(usageEventAccountStamp(company)).not.toBe(
      usageEventAccountStamp(personal),
    );
    // 稳定：同一绑定重算同戳。
    expect(usageEventAccountStamp(company)).toBe(
      usageEventAccountStamp(company),
    );
  });

  test("credential-shaped values are refused as account fields", () => {
    expect(() =>
      bindUsageEventAccount({
        kind: "company",
        payerId: "tenant-acme",
        externalCustomerId:
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      }),
    ).toThrow(USAGE_EVENT_ACCOUNT_INVALID);
    expect(() =>
      bindUsageEventAccount({
        kind: "personal",
        payerId: "sk-ant-api03-fixture-key-1234567890abcdef",
        externalCustomerId: "openbot-personal-user-1",
      }),
    ).toThrow(USAGE_EVENT_ACCOUNT_INVALID);
  });

  test("an unclassified account is quarantined explicitly, never defaulted to personal", () => {
    const quarantined = quarantineUsageEventAccount("payer_mapping_missing");
    expect(quarantined.status).toBe("quarantined");
    expect(quarantined.reason).toBe("payer_mapping_missing");
    // quarantine 结果不是绑定：没有任何账户字段可计费。
    expect("kind" in quarantined).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2：重放同一事件不会记到另一账户
// ---------------------------------------------------------------------------

describe("MT109 AC2 replaying one event never records onto another account", () => {
  test("a first record writes once; the same event under the same account replays as a no-op", () => {
    const sink = recordingSink();
    const recorder = createUsageEventRecorder(sink);
    const event = usageEvent("evt-1", COMPANY_ACCOUNT);

    expect(recorder.record(event)).toEqual({ status: "recorded" });
    // 传输层重投同一事件：replayed，零二次写入。
    expect(recorder.record(event)).toEqual({
      status: "replayed",
      accountStamp: usageEventAccountStamp(COMPANY_ACCOUNT),
    });
    expect(recorder.record(usageEvent("evt-1", COMPANY_ACCOUNT))).toEqual({
      status: "replayed",
      accountStamp: usageEventAccountStamp(COMPANY_ACCOUNT),
    });
    expect(sink.written).toHaveLength(1);
  });

  test("the same event id under ANOTHER account is refused with both stamps, and writes nothing", () => {
    const sink = recordingSink();
    const recorder = createUsageEventRecorder(sink);
    expect(recorder.record(usageEvent("evt-2", COMPANY_ACCOUNT))).toEqual({
      status: "recorded",
    });

    // 个人账户重放公司事件：拒绝，公司账户的记录原样不动。
    const refusal = recorder.record(usageEvent("evt-2", PERSONAL_ACCOUNT));
    expect(refusal).toEqual({
      status: "refused",
      code: "USAGE_EVENT_ACCOUNT_MISMATCH",
      eventId: "evt-2",
      recordedUnder: usageEventAccountStamp(COMPANY_ACCOUNT),
      replayedUnder: usageEventAccountStamp(PERSONAL_ACCOUNT),
    });
    expect(sink.written).toHaveLength(1);
    expect(sink.written[0]?.account.kind).toBe("company");

    // 拒绝不是占位：该事件 id 之后在原账户重放仍是 replayed，不产生第二行。
    expect(recorder.record(usageEvent("evt-2", COMPANY_ACCOUNT))).toEqual({
      status: "replayed",
      accountStamp: usageEventAccountStamp(COMPANY_ACCOUNT),
    });
    expect(sink.written).toHaveLength(1);
  });

  test("different events under one account are different records — idempotency is per event", () => {
    const sink = recordingSink();
    const recorder = createUsageEventRecorder(sink);
    recorder.record(usageEvent("evt-3", PERSONAL_ACCOUNT));
    recorder.record(usageEvent("evt-4", PERSONAL_ACCOUNT));
    expect(sink.written).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC3：脱敏覆盖票面点名的每个向量（含错误与异常路径）
// ---------------------------------------------------------------------------

describe("MT109 AC3 redaction covers every named vector, error paths included", () => {
  test("service tokens, cookies, OAuth, personal keys and credential bodies leave the shared rules", () => {
    const vectors: Array<[string, string]> = [
      // 服务 token
      [
        "provider failed after Authorization: Bearer ghp_16C7e42F292c6912E7710c838347Ae178B4a",
        "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      ],
      [
        "slack bot xoxb-1234567890abcdefABCD rejected",
        "xoxb-1234567890abcdefABCD",
      ],
      // cookie
      [
        "upstream said: Cookie: session=s3cr3t-sess-1; theme=dark",
        "s3cr3t-sess-1",
      ],
      ["set-cookie: sid=deadbeef42; Path=/", "deadbeef42"],
      // OAuth
      [
        "callback https://provider.invalid/cb?code=SplxlOBezQQYbYS6WxSbIA&state=xyz",
        "SplxlOBezQQYbYS6WxSbIA",
      ],
      [
        "token url ?client_secret=sekret-9182&grant_type=authorization_code",
        "sekret-9182",
      ],
      // 个人 Key
      [
        "model rejected sk-ant-api03-fixture-key-1234567890abcdef",
        "sk-ant-api03-fixture-key-1234567890abcdef",
      ],
      // 凭据正文
      ["retry with password=hunter2 and user ann", "hunter2"],
    ];
    for (const [text, secret] of vectors) {
      const scrubbed = scrubCommand(text);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain("[REDACTED]");
    }
  });

  test("redactUsageEvent scrubs detail AND the error/exception half, keeping the account intact", () => {
    const personalKey = "sk-ant-api03-fixture-key-1234567890abcdef";
    const sessionCookie = "s3cr3t-sess-1";
    const oauthCode = "SplxlOBezQQYbYS6WxSbIA";
    const event = usageEvent("evt-5", COMPANY_ACCOUNT, {
      detail: `upstream said Cookie: session=${sessionCookie} then 500'd`,
      error: {
        code: "upstream_rejected",
        message: `provider failed for https://provider.invalid/cb?code=${oauthCode} with key ${personalKey}`,
      },
    });
    const redacted = redactUsageEvent(event);
    expect(redacted.detail).not.toContain(sessionCookie);
    expect(redacted.error?.message).not.toContain(oauthCode);
    expect(redacted.error?.message).not.toContain(personalKey);
    expect(redacted.error?.message).toContain("[REDACTED]");
    // 账户绑定是裸标识，原样通过（不混淆、不脱敏成不可对账）。
    expect(redacted.account).toEqual(COMPANY_ACCOUNT);
    // 原事件不被就地改写：脱敏产物是新对象。
    expect(event.error?.message).toContain(personalKey);
  });

  test("an error code that swallowed a token is scrubbed too", () => {
    const event = usageEvent("evt-6", PERSONAL_ACCOUNT, {
      error: {
        // 凭据形状自身匹配 TOKEN_SHAPES；错误码的分隔符（-）给它词边界。
        code: "auth-rejected-ghp_16C7e42F292c6912E7710c838347Ae178B4a",
        message: "401",
      },
    });
    expect(redactUsageEvent(event).error?.code).not.toContain("ghp_16C7e42F");
    expect(redactUsageEvent(event).error?.code).toContain("[REDACTED]");
  });
});
