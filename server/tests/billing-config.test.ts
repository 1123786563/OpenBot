import { describe, expect, test } from "../../tests/support/e2e-compat";
import { loadConfig } from "../src/config";

/*
 * The billing configuration is an all-or-nothing block: everything here asserts either the block
 * absent (a free deployment), or the block whole and refused where it is half-shaped. The base
 * environment is the one config.test.ts uses, so a case that fails on something besides LAGO_* is
 * a case about the base, and gets fixed in the base.
 */
const baseEnvironment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

function unconfiguredPolicyIssues(config: ReturnType<typeof loadConfig>) {
  const policy = config.billing?.creditPolicy;
  if (!policy || policy.configured) {
    throw new Error("expected an unconfigured billing credit policy");
  }
  return policy.issues;
}

describe("billing configuration", () => {
  test("no LAGO_* variables at all means no billing surface", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.billing).toBeUndefined();
  });

  test("a URL without a key stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
      }),
    ).toThrow(/LAGO_API_URL and LAGO_API_KEY must be set together/);
  });

  test("a key without a URL stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/LAGO_API_URL and LAGO_API_KEY must be set together/);
  });

  test("a URL ending in /api/v1 is refused with the origin-only reminder", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com/api/v1",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/origin.*the client adds the \/api\/v1 prefix itself/s);
  });

  test("a URL with any other path is refused too", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com/lago",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/provider origin only, without a path/);
  });

  test("a URL with a query or fragment is refused", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com?x=1",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/provider origin only/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com/#here",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/provider origin only/);
  });

  test("a non-http(s) URL is refused, matching the outbound policy's scheme allow-list", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "ftp://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/http or https/);
  });

  test("credentials in the URL are refused; the key has its own variable", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://user:pass@api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/must not carry credentials/);
  });

  test("both webhook keys together stop the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_WEBHOOK_SECRET: "hmac-token",
        LAGO_WEBHOOK_PUBLIC_KEY:
          "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      }),
    ).toThrow(/exactly one/);
  });

  test("malformed plan entitlements JSON stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: "{pro",
      }),
    ).toThrow(/LAGO_PLAN_ENTITLEMENTS must be valid JSON/);
  });

  test("plan entitlements of the wrong shape stop the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: '["pro"]',
      }),
    ).toThrow(/must be a JSON object/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: '{"pro": "intelligence"}',
      }),
    ).toThrow(/must be a list of non-empty entitlement codes/);
  });

  test("a request timeout that is not a positive whole number stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_REQUEST_TIMEOUT_MS: "zero",
      }),
    ).toThrow(/whole number of milliseconds/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_REQUEST_TIMEOUT_MS: "-5",
      }),
    ).toThrow(/whole number of milliseconds/);
  });

  test("the minimal legal pair resolves with every field in its default shape", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
    });
    expect(config.billing).toMatchObject({
      apiUrl: "https://api.getlago.com",
      apiKey: "provider-bearer-key",
      webhookMode: "off",
      webhookKey: undefined,
      allowPrivateHosts: false,
      planEntitlements: new Map(),
      planQuotas: new Map(),
      planCatalog: new Map(),
    });
    expect(config.billing?.creditPolicy).toEqual({
      configured: false,
      mode: "hard_cap",
      issues: [
        {
          key: "BILLING_MODEL_CREDIT_RATES",
          reason: "missing",
        },
        {
          key: "BILLING_MODEL_MAX_RESERVATION_TOKENS",
          reason: "missing",
        },
        {
          key: "BILLING_CODE_RUN_CREDIT_RATE",
          reason: "missing",
        },
        {
          key: "BILLING_CODE_RUN_MAX_RESERVATION_TOKENS",
          reason: "missing",
        },
      ],
    });
  });

  test("a complete hard-cap credit policy parses exact rationals and reservation ceilings", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({
        "openai/gpt-5.5": {
          input: { numerator: "1", denominator: "3" },
          output: { numerator: "5", denominator: "4" },
        },
      }),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "7",
          output: "2",
        },
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2",
        denominator: "3",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "5",
    });
    expect(config.billing?.creditPolicy).toEqual({
      configured: true,
      mode: "hard_cap",
      models: new Map([
        [
          "openai/gpt-5.5",
          {
            input: {
              maximumCostUnits: 3n,
              maximumTokens: 7n,
              rate: { numerator: 1n, denominator: 3n },
            },
            output: {
              maximumCostUnits: 3n,
              maximumTokens: 2n,
              rate: { numerator: 5n, denominator: 4n },
            },
            maximumReservationUnits: 6n,
          },
        ],
      ]),
      codeRun: {
        maximumReservationUnits: 4n,
        maximumTokens: 5n,
        rate: { numerator: 2n, denominator: 3n },
      },
    });
  });

  test("exactly divisible reservation arithmetic stays exact instead of rounding up", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({
        "openai/gpt-5.5": {
          input: { numerator: "3", denominator: "2" },
          output: { numerator: "4", denominator: "2" },
        },
      }),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "4",
          output: "6",
        },
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "6",
        denominator: "3",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "9",
    });
    expect(config.billing?.creditPolicy).toEqual({
      configured: true,
      mode: "hard_cap",
      models: new Map([
        [
          "openai/gpt-5.5",
          {
            input: {
              maximumCostUnits: 6n,
              maximumTokens: 4n,
              rate: { numerator: 3n, denominator: 2n },
            },
            output: {
              maximumCostUnits: 12n,
              maximumTokens: 6n,
              rate: { numerator: 4n, denominator: 2n },
            },
            maximumReservationUnits: 18n,
          },
        ],
      ]),
      codeRun: {
        maximumReservationUnits: 18n,
        maximumTokens: 9n,
        rate: { numerator: 6n, denominator: 3n },
      },
    });
  });

  test("empty model policy leaves the hard-cap policy unconfigured", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({}),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({}),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2",
        denominator: "3",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "5",
    });
    expect(config.billing?.creditPolicy).toEqual({
      configured: false,
      mode: "hard_cap",
      issues: [
        {
          key: "BILLING_MODEL_CREDIT_RATES",
          reason: "missing",
        },
      ],
    });
  });

  test("missing rate fields leave the hard-cap policy unconfigured and synthesize no default", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({
        "openai/gpt-5.5": {
          input: { numerator: "1", denominator: "3" },
        },
      }),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "7",
          output: "2",
        },
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "5",
    });
    expect(config.billing?.creditPolicy).toMatchObject({
      configured: false,
      mode: "hard_cap",
    });
    const issues = unconfiguredPolicyIssues(config);
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          key: "BILLING_MODEL_CREDIT_RATES.openai/gpt-5.5.output",
          reason: "missing",
        },
        {
          key: "BILLING_CODE_RUN_CREDIT_RATE",
          reason: "missing",
        },
      ]),
    );
  });

  test("missing maximum reservation bounds leave the hard-cap policy unconfigured", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({
        "openai/gpt-5.5": {
          input: { numerator: "1", denominator: "3" },
          output: { numerator: "5", denominator: "4" },
        },
      }),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "7",
        },
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2",
        denominator: "3",
      }),
    });
    expect(config.billing?.creditPolicy).toMatchObject({
      configured: false,
      mode: "hard_cap",
    });
    const issues = unconfiguredPolicyIssues(config);
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          key: "BILLING_MODEL_MAX_RESERVATION_TOKENS.openai/gpt-5.5.output",
          reason: "missing",
        },
        {
          key: "BILLING_CODE_RUN_MAX_RESERVATION_TOKENS",
          reason: "missing",
        },
      ]),
    );
  });

  test("zero denominators and negative values leave the hard-cap policy unconfigured", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({
        "openai/gpt-5.5": {
          input: { numerator: "-1", denominator: "3" },
          output: { numerator: "5", denominator: "0" },
        },
      }),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "-7",
          output: "2",
        },
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2",
        denominator: "0",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "-5",
    });
    expect(config.billing?.creditPolicy).toMatchObject({
      configured: false,
      mode: "hard_cap",
    });
    const issues = unconfiguredPolicyIssues(config);
    expect(issues).toHaveLength(5);
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          key: "BILLING_MODEL_CREDIT_RATES.openai/gpt-5.5.input.numerator",
          reason: "negative",
        },
        {
          key: "BILLING_MODEL_CREDIT_RATES.openai/gpt-5.5.output.denominator",
          reason: "zero_denominator",
        },
        {
          key: "BILLING_MODEL_MAX_RESERVATION_TOKENS.openai/gpt-5.5.input",
          reason: "negative",
        },
        {
          key: "BILLING_CODE_RUN_CREDIT_RATE.denominator",
          reason: "zero_denominator",
        },
        {
          key: "BILLING_CODE_RUN_MAX_RESERVATION_TOKENS",
          reason: "negative",
        },
      ]),
    );
  });

  test("unsafe integer inputs leave the hard-cap policy unconfigured", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: `{"openai/gpt-5.5":{"input":{"numerator":9007199254740992,"denominator":3},"output":{"numerator":5,"denominator":4}}}`,
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "7",
          output: "2",
        },
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2",
        denominator: "3",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "5",
    });
    expect(config.billing?.creditPolicy).toEqual({
      configured: false,
      mode: "hard_cap",
      issues: [
        {
          key: "BILLING_MODEL_CREDIT_RATES.openai/gpt-5.5.input.numerator",
          reason: "out_of_range",
        },
      ],
    });
  });

  test("malformed JSON and wrong-shape policy values leave the hard-cap policy unconfigured", () => {
    const malformed = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: "{",
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "7",
          output: "2",
        },
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2",
        denominator: "3",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "5",
    });
    expect(malformed.billing?.creditPolicy).toMatchObject({
      configured: false,
      mode: "hard_cap",
    });
    expect(unconfiguredPolicyIssues(malformed)).toEqual(
      expect.arrayContaining([
        {
          key: "BILLING_MODEL_CREDIT_RATES",
          reason: "invalid_json",
        },
      ]),
    );

    const wrongShape = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify([]),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({}),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify(["wrong"]),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "5",
    });
    expect(wrongShape.billing?.creditPolicy).toMatchObject({
      configured: false,
      mode: "hard_cap",
    });
    const wrongShapeIssues = unconfiguredPolicyIssues(wrongShape);
    expect(wrongShapeIssues).toContainEqual({
      key: "BILLING_MODEL_CREDIT_RATES",
      reason: "invalid_shape",
    });
    expect(wrongShapeIssues).toContainEqual({
      key: "BILLING_CODE_RUN_CREDIT_RATE",
      reason: "invalid_shape",
    });

    const wrongShapeMaximums = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({
        "openai/gpt-5.5": {
          input: { numerator: "1", denominator: "1" },
          output: { numerator: "1", denominator: "1" },
        },
      }),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": "wrong",
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2",
        denominator: "3",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "5",
    });
    expect(wrongShapeMaximums.billing?.creditPolicy).toMatchObject({
      configured: false,
      mode: "hard_cap",
    });
    expect(unconfiguredPolicyIssues(wrongShapeMaximums)).toEqual(
      expect.arrayContaining([
        {
          key: "BILLING_MODEL_MAX_RESERVATION_TOKENS.openai/gpt-5.5",
          reason: "invalid_shape",
        },
      ]),
    );
  });

  test("quoted huge rates that overflow 32-bit stored credit units leave the policy unconfigured", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      BILLING_MODEL_CREDIT_RATES: JSON.stringify({
        "openai/gpt-5.5": {
          input: { numerator: "2147483648", denominator: "1" },
          output: { numerator: "1", denominator: "1" },
        },
      }),
      BILLING_MODEL_MAX_RESERVATION_TOKENS: JSON.stringify({
        "openai/gpt-5.5": {
          input: "1",
          output: "1",
        },
      }),
      BILLING_CODE_RUN_CREDIT_RATE: JSON.stringify({
        numerator: "2147483648",
        denominator: "1",
      }),
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "1",
    });
    expect(config.billing?.creditPolicy).toMatchObject({
      configured: false,
      mode: "hard_cap",
    });
    expect(unconfiguredPolicyIssues(config)).toEqual(
      expect.arrayContaining([
        {
          key: "BILLING_MODEL_MAX_RESERVATION_TOKENS.openai/gpt-5.5",
          reason: "out_of_range",
        },
        {
          key: "BILLING_CODE_RUN_MAX_RESERVATION_TOKENS",
          reason: "out_of_range",
        },
      ]),
    );
  });

  test("one model's bad rate leaves the policy unconfigured and names the offending key", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://lago.stub.test",
      LAGO_API_KEY: "stub-key",
      BILLING_MODEL_CREDIT_RATES:
        '{"GLM-5.3":{"input":{"numerator":"1","denominator":"100"},"output":{"numerator":"1","denominator":"0"}}}',
      BILLING_MODEL_MAX_RESERVATION_TOKENS:
        '{"GLM-5.3":{"input":"128000","output":"16384"}}',
      BILLING_CODE_RUN_CREDIT_RATE: '{"numerator":"1","denominator":"100"}',
      BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "100000",
    });
    expect(config.billing?.creditPolicy.configured).toBe(false);
    expect(config.billing?.creditPolicy.mode).toBe("hard_cap");
    const policy = config.billing?.creditPolicy;
    if (policy && policy.configured === false) {
      expect(policy.issues.map((i) => i.key)).toContain(
        "BILLING_MODEL_CREDIT_RATES.GLM-5.3.output.denominator",
      );
    }
  });

  test("the jwt webhook key selects jwt mode and is carried verbatim", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_WEBHOOK_PUBLIC_KEY: pem,
    });
    expect(config.billing?.webhookMode).toBe("jwt");
    expect(config.billing?.webhookKey).toEqual({
      mode: "jwt",
      publicKeyPem: pem,
    });
  });

  test("the hmac webhook key selects hmac mode", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_WEBHOOK_SECRET: "endpoint-hmac-token",
    });
    expect(config.billing?.webhookMode).toBe("hmac");
    expect(config.billing?.webhookKey).toEqual({
      mode: "hmac",
      key: "endpoint-hmac-token",
    });
  });

  test("the plan map resolves into plan code → entitlement codes", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_ENTITLEMENTS: '{"pro": ["intelligence", "teams"], "trial": []}',
    });
    expect(config.billing?.planEntitlements).toEqual(
      new Map([
        ["pro", [{ code: "intelligence" }, { code: "teams" }]],
        ["trial", []],
      ]),
    );
  });

  // 旧形态：纯字符串数组，仍被接受
  test("LAGO_PLAN_ENTITLEMENTS accepts the legacy list-of-codes form", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_ENTITLEMENTS: JSON.stringify({
        pro: ["agents.pro", "skills.advanced"],
      }),
    });
    expect(config.billing?.planEntitlements.get("pro")).toEqual([
      { code: "agents.pro" },
      { code: "skills.advanced" },
    ]);
  });

  // 新形态：对象条目
  test("LAGO_PLAN_ENTITLEMENTS accepts entries with label and description", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_ENTITLEMENTS: JSON.stringify({
        pro: [
          { code: "agents.pro", label: "Pro 代理", description: "不限量代理" },
        ],
      }),
    });
    expect(config.billing?.planEntitlements.get("pro")).toEqual([
      { code: "agents.pro", label: "Pro 代理", description: "不限量代理" },
    ]);
  });

  // 非法：条目既非字符串也非对象 / 对象缺 code / label 非字符串
  test("LAGO_PLAN_ENTITLEMENTS rejects malformed entries", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ pro: [{ label: "no code" }] }),
      }),
    ).toThrow(/"code"/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ pro: [42] }),
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: JSON.stringify({
          pro: [{ code: "a", label: 3 }],
        }),
      }),
    ).toThrow(/label/);
  });

  test("a legal timeout and the private-host opt-in are carried", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_REQUEST_TIMEOUT_MS: "25000",
      LAGO_ALLOW_PRIVATE_HOSTS: "true",
    });
    expect(config.billing?.requestTimeoutMs).toBe(25_000);
    expect(config.billing?.allowPrivateHosts).toBe(true);
  });

  test("LAGO_PLAN_QUOTAS resolves into plan code → ceilings", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_QUOTAS: JSON.stringify({
        pro: [
          {
            metricCode: "llm_tokens",
            metricName: "模型 tokens",
            unit: "tokens",
            limit: 2_000_000,
          },
        ],
      }),
    });
    expect(config.billing?.planQuotas.get("pro")).toEqual([
      {
        metricCode: "llm_tokens",
        metricName: "模型 tokens",
        unit: "tokens",
        used: 0,
        limit: 2_000_000,
        remaining: 2_000_000,
        usedCents: 0,
      },
    ]);
  });

  test("a quota with no unit falls back to the metric code rather than a guess", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_QUOTAS: JSON.stringify({
        pro: [{ metricCode: "llm_tokens", limit: 10 }],
      }),
    });
    expect(config.billing?.planQuotas.get("pro")).toEqual([
      {
        metricCode: "llm_tokens",
        metricName: "llm_tokens",
        unit: "llm_tokens",
        used: 0,
        limit: 10,
        remaining: 10,
        usedCents: 0,
      },
    ]);
  });

  test("LAGO_PLAN_QUOTAS rejects a ceiling it cannot honour", () => {
    const withQuotas = (value: unknown) =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_QUOTAS: JSON.stringify(value),
      });
    // Not JSON at all.
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_QUOTAS: "{",
      }),
    ).toThrow(/valid JSON/);
    // A fraction of a token is not a thing.
    expect(() =>
      withQuotas({ pro: [{ metricCode: "m", limit: 1.5 }] }),
    ).toThrow(/whole number/);
    expect(() => withQuotas({ pro: [{ metricCode: "m", limit: -1 }] })).toThrow(
      /negative/,
    );
    expect(() => withQuotas({ pro: [{ limit: 1 }] })).toThrow(/metricCode/);
    expect(() => withQuotas({ pro: [{ metricCode: "m" }] })).toThrow(/limit/);
    expect(() => withQuotas({ pro: "nope" })).toThrow(/list of quota objects/);
  });

  test("absent quotas are an empty map, which means metered and uncapped", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
    });
    expect(config.billing?.planQuotas.size).toBe(0);
  });

  test("LAGO_PLAN_CATALOG resolves into plan code → catalog entry", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_CATALOG: JSON.stringify({
        advanced: {
          name: "高级版",
          credits: 9000,
          features: ["每月基础积分", "全部模型可选"],
          pricing: [
            {
              code: "recurring_monthly",
              label: "连续包月",
              priceCents: 14000,
              originalCents: 19900,
              discountLabel: "7折",
              unit: "month",
            },
            {
              code: "monthly",
              label: "1个月",
              priceCents: 19900,
              unit: "month",
            },
          ],
        },
      }),
    });
    expect(config.billing?.planCatalog.get("advanced")).toEqual({
      name: "高级版",
      credits: 9000,
      features: ["每月基础积分", "全部模型可选"],
      pricing: [
        {
          code: "recurring_monthly",
          label: "连续包月",
          priceCents: 14000,
          originalCents: 19900,
          discountLabel: "7折",
          unit: "month",
        },
        {
          code: "monthly",
          label: "1个月",
          priceCents: 19900,
          originalCents: null,
          discountLabel: null,
          unit: "month",
        },
      ],
    });
  });

  test("a catalog cycle without unit derives it from the code", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_CATALOG: JSON.stringify({
        pro: {
          name: "标准版",
          credits: 4000,
          features: ["x"],
          pricing: [{ code: "recurring_yearly", priceCents: 134400 }],
        },
      }),
    });
    expect(config.billing?.planCatalog.get("pro")?.pricing[0]).toEqual({
      code: "recurring_yearly",
      label: "recurring_yearly",
      priceCents: 134400,
      originalCents: null,
      discountLabel: null,
      unit: "year",
    });
  });

  test("LAGO_PLAN_CATALOG rejects a plan it cannot draw", () => {
    const withCatalog = (value: unknown) =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_CATALOG: JSON.stringify(value),
      });
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_CATALOG: "{",
      }),
    ).toThrow(/valid JSON/);
    expect(() => withCatalog({ pro: { credits: 1 } })).toThrow(/name/);
    expect(() =>
      withCatalog({
        pro: { name: "x", credits: -1, features: [], pricing: [] },
      }),
    ).toThrow(/credits/);
    expect(() =>
      withCatalog({
        pro: { name: "x", credits: 1, features: [], pricing: [] },
      }),
    ).toThrow(/pricing/);
    expect(() =>
      withCatalog({
        pro: {
          name: "x",
          credits: 1,
          features: ["a"],
          pricing: [{ code: "nope", priceCents: 1 }],
        },
      }),
    ).toThrow(/cycle code/);
    expect(() =>
      withCatalog({
        pro: {
          name: "x",
          credits: 1,
          features: ["a"],
          pricing: [{ code: "monthly", priceCents: -1 }],
        },
      }),
    ).toThrow(/priceCents/);
    expect(() => withCatalog({ pro: "nope" })).toThrow(/object/);
  });

  test("absent catalog is an empty map, which hides the upgrade dialog", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
    });
    expect(config.billing?.planCatalog.size).toBe(0);
  });

  test("a plan allowance that cannot fit the ledger's 32-bit column refuses to start", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://lago.stub.test",
        LAGO_API_KEY: "stub-key",
        LAGO_PLAN_CATALOG:
          '{"standard":{"name":"标准版","credits":30000000,"features":["a"],"pricing":[{"code":"monthly","priceCents":4900,"unit":"month"}]}}',
      }),
    ).toThrow(/credits must fit the credit ledger's 32-bit column/);
  });

  test("a price that cannot fit the order table's 32-bit column refuses to start", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://lago.stub.test",
        LAGO_API_KEY: "stub-key",
        LAGO_PLAN_CATALOG:
          '{"standard":{"name":"标准版","credits":100,"features":["a"],"pricing":[{"code":"monthly","priceCents":99999999999,"unit":"month"}]}}',
      }),
    ).toThrow(/priceCents must fit the payment order table's 32-bit column/);
  });

  test("the largest representable allowance is accepted exactly", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://lago.stub.test",
      LAGO_API_KEY: "stub-key",
      LAGO_PLAN_CATALOG:
        '{"standard":{"name":"标准版","credits":21474836,"features":["a"],"pricing":[{"code":"monthly","priceCents":2147483647,"unit":"month"}]}}',
    });
    expect(config.billing?.planCatalog.get("standard")?.credits).toBe(21474836);
  });
});
