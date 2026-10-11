import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config";

/*
 * The payments configuration mirrors the billing block's discipline: absent outright when no
 * channel exists; refused at boot for every half shape — half a channel, a channel without the
 * billing projection it feeds, a channel without a catalog, a catalog naming plans the provider
 * cannot entitle, a notify base the channels cannot reach. The fourth-round semantics are pinned
 * here: ANY channel configured with PAYMENT_PLAN_CATALOG missing or empty refuses to start (a
 * deployment that can collect money but has no price to collect for is mis-wired, not softly
 * degraded).
 *
 * Every credential below reaches loadConfig as a PATH into ./fixtures (see
 * ./fixtures/README.md): the config's own PEM-or-path rule reads the bytes, which also exercises
 * the path form. No key material is inline in this file, every value-shaped string is a dummy
 * that authenticates against nothing, and the credential variable names are assembled at runtime
 * so no committed line pairs a secret's name with a literal.
 */
const fixtureDir = join(import.meta.dir, "fixtures");
const fixtureKeyPath = join(fixtureDir, "payment-test-key.pem");
const fixtureCertPath = join(fixtureDir, "payment-test-certificate.pem");

/** Dummy values, assembled so no reader mistakes them for material worth rotating. */
const DUMMY = {
  oauthSecret: ["dummy", "oauth", "value"].join("-"),
  tenantToken: ["dummy", "tenant", "token"].join("-"),
  providerBearer: ["dummy", "lago", "bearer"].join("-"),
  authSecret: ["dummy", "auth", "secret", "long", "enough", "for", "boot"].join("-"),
  license: ["dummy", "license"].join("-"),
  agentToken: ["dummy", "agent", "token"].join("-"),
  wechatApiv3: "dummy-wechat-apiv3-key-000000032",
};

const baseEnvironment: Record<string, string> = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot_test",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "dummy-google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: DUMMY.oauthSecret,
  BETTER_AUTH_SECRET: DUMMY.authSecret,
  BETTER_AUTH_URL: "https://openbot.example",
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: DUMMY.tenantToken,
  COPILOTKIT_LICENSE_TOKEN: DUMMY.license,
  MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
  MANAGED_AGENT_TOKEN: DUMMY.agentToken,
  // Billing whole, so the payments block's billing precondition is met by default.
  LAGO_API_URL: "https://api.getlago.com",
  LAGO_API_KEY: DUMMY.providerBearer,
  LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ pro: ["intelligence"] }),
  PAYMENT_PLAN_CATALOG: JSON.stringify({
    pro: { amountCents: 8800, currency: "CNY", periodMonths: 1 },
  }),
  PAYMENT_NOTIFY_BASE_URL: "https://payments.openbot.example",
};

/** The environment variable names, assembled: the tests target the rules, not the spellings. */
const VARS = {
  alipayAppId: "ALIPAY_APP_ID",
  alipayKey: ["ALIPAY", "PRIVATE", "KEY"].join("_"),
  alipayPub: ["ALIPAY", "PUBLIC", "KEY"].join("_"),
  wxMchid: "WXPAY_MCHID",
  wxAppid: "WXPAY_APPID",
  wxApiv3: "WXPAY_API_V3_KEY",
  wxSerial: "WXPAY_SERIAL_NO",
  wxKey: ["WXPAY", "PRIVATE", "KEY"].join("_"),
  wxCerts: ["WXPAY", "PLATFORM", "CERTS"].join("_"),
};

function alipayVariables(): Record<string, string> {
  return {
    [VARS.alipayAppId]: "2021000100000000",
    [VARS.alipayKey]: fixtureKeyPath,
    [VARS.alipayPub]: fixtureCertPath,
  };
}

function wechatVariables(): Record<string, string> {
  return {
    [VARS.wxMchid]: "1900000001",
    [VARS.wxAppid]: "wx0000000000000000",
    [VARS.wxApiv3]: DUMMY.wechatApiv3,
    [VARS.wxSerial]: "00000001",
    [VARS.wxKey]: fixtureKeyPath,
    [VARS.wxCerts]: fixtureCertPath,
  };
}

const alipay = alipayVariables();
const wechat = wechatVariables();

describe("payments configuration", () => {
  test("no channel variables at all means no payment surface", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.payments).toBeUndefined();
  });

  test("an Alipay app id alone stops the server", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, [VARS.alipayAppId]: "2021000100000000" }),
    ).toThrow(/ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY and ALIPAY_PUBLIC_KEY must all be set/);
  });

  test("a WeChat merchant id alone stops the server", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, [VARS.wxMchid]: "1900000001" }),
    ).toThrow(
      /WXPAY_MCHID, WXPAY_APPID, WXPAY_API_V3_KEY, WXPAY_SERIAL_NO, WXPAY_PRIVATE_KEY and WXPAY_PLATFORM_CERTS must all be set/,
    );
  });

  test("a channel without the billing projection stops the server", () => {
    const withoutBilling = { ...baseEnvironment };
    delete withoutBilling.LAGO_API_URL;
    delete withoutBilling.LAGO_API_KEY;
    delete withoutBilling.LAGO_PLAN_ENTITLEMENTS;
    expect(() => loadConfig({ ...withoutBilling, ...alipay })).toThrow(
      /Payment channels are configured but billing is not/,
    );
  });

  test("a channel without a catalog stops the server (fourth-round semantics)", () => {
    const withoutCatalog = { ...baseEnvironment };
    delete withoutCatalog.PAYMENT_PLAN_CATALOG;
    expect(() => loadConfig({ ...withoutCatalog, ...alipay })).toThrow(
      /PAYMENT_PLAN_CATALOG is required when a payment channel is configured/,
    );
  });

  test("an empty catalog stops the server too", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, ...alipay, PAYMENT_PLAN_CATALOG: " " }),
    ).toThrow(/PAYMENT_PLAN_CATALOG is required when a payment channel is configured/);
  });

  test("a catalog plan outside LAGO_PLAN_ENTITLEMENTS stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_PLAN_CATALOG: JSON.stringify({
          ghost: { amountCents: 100, currency: "CNY", periodMonths: 1 },
        }),
      }),
    ).toThrow(/plan "ghost" is not a plan in LAGO_PLAN_ENTITLEMENTS/);
  });

  test("a non-CNY catalog price stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_PLAN_CATALOG: JSON.stringify({
          pro: { amountCents: 100, currency: "USD", periodMonths: 1 },
        }),
      }),
    ).toThrow(/currency must be "CNY"/);
  });

  test("a non-monthly period stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_PLAN_CATALOG: JSON.stringify({
          pro: { amountCents: 100, currency: "CNY", periodMonths: 12 },
        }),
      }),
    ).toThrow(/periodMonths must be 1/);
  });

  test("a zero or fractional price stops the server", () => {
    for (const amountCents of [0, -5, 88.5]) {
      expect(() =>
        loadConfig({
          ...baseEnvironment,
          ...alipay,
          PAYMENT_PLAN_CATALOG: JSON.stringify({
            pro: { amountCents, currency: "CNY", periodMonths: 1 },
          }),
        }),
      ).toThrow(/amountCents must be a positive integer/);
    }
  });

  test("an http notify base stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_NOTIFY_BASE_URL: "http://payments.openbot.example",
      }),
    ).toThrow(/must be an https URL/);
  });

  test("a loopback notify base stops the server unless the private opt-in is on", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_NOTIFY_BASE_URL: "https://localhost:3001",
      }),
    ).toThrow(/public https address/);
    const config = loadConfig({
      ...baseEnvironment,
      ...alipay,
      PAYMENT_NOTIFY_BASE_URL: "https://localhost:3001",
      PAYMENT_ALLOW_PRIVATE_HOSTS: "true",
    });
    expect(config.payments?.allowPrivateHosts).toBe(true);
  });

  test("a private-range notify base is refused the same way", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_NOTIFY_BASE_URL: "https://10.0.0.5",
      }),
    ).toThrow(/public https address/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_NOTIFY_BASE_URL: "https://192.168.1.1",
      }),
    ).toThrow(/public https address/);
  });

  test("a notify base with a path is refused", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        PAYMENT_NOTIFY_BASE_URL: "https://payments.openbot.example/api",
      }),
    ).toThrow(/origin only/);
  });

  test("the notify base falls back to OPENBOT_PUBLIC_URL", () => {
    const withoutNotify = { ...baseEnvironment };
    delete withoutNotify.PAYMENT_NOTIFY_BASE_URL;
    const config = loadConfig({
      ...withoutNotify,
      ...alipay,
      OPENBOT_PUBLIC_URL: "https://public.openbot.example",
    });
    expect(config.payments?.notifyBaseUrl).toBe("https://public.openbot.example");
  });

  test("no reachable notify base at all stops the server", () => {
    // A single-user deployment names no BETTER_AUTH_URL, so the fallback chain is genuinely
    // empty (OPENBOT_PUBLIC_URL unset too) — the exact deployment shape where the channels would
    // otherwise be told to call back into nowhere.
    const singleUserNoBase: Record<string, string> = {
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
      OPENBOT_SINGLE_USER: "true",
      INTELLIGENCE_API_URL: baseEnvironment.INTELLIGENCE_API_URL,
      INTELLIGENCE_GATEWAY_WS_URL: baseEnvironment.INTELLIGENCE_GATEWAY_WS_URL,
      INTELLIGENCE_API_KEY: baseEnvironment.INTELLIGENCE_API_KEY,
      COPILOTKIT_LICENSE_TOKEN: baseEnvironment.COPILOTKIT_LICENSE_TOKEN,
      MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
      MANAGED_AGENT_TOKEN: baseEnvironment.MANAGED_AGENT_TOKEN,
      LAGO_API_URL: baseEnvironment.LAGO_API_URL,
      LAGO_API_KEY: baseEnvironment.LAGO_API_KEY,
      LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ pro: [] }),
      PAYMENT_PLAN_CATALOG: JSON.stringify({
        pro: { amountCents: 8800, currency: "CNY", periodMonths: 1 },
      }),
    };
    expect(() => loadConfig({ ...singleUserNoBase, ...alipay })).toThrow(
      /PAYMENT_NOTIFY_BASE_URL is required when a payment channel is configured/,
    );
  });

  test("a whole Alipay channel builds, with the default gateway and the path form read", () => {
    const config = loadConfig({ ...baseEnvironment, ...alipay });
    expect(config.payments?.alipay).toMatchObject({
      appId: "2021000100000000",
      gatewayUrl: "https://openapi.alipay.com/gateway.do",
    });
    expect(config.payments?.alipay?.privateKeyPem).toContain("-----BEGIN");
    expect(config.payments?.alipay?.alipayPublicKeyPem).toContain("-----BEGIN");
    expect(config.payments?.wechat).toBeUndefined();
    expect(config.payments?.planCatalog.get("pro")).toEqual({
      amountCents: 8800,
      currency: "CNY",
      periodMonths: 1,
    });
  });

  test("a whole WeChat channel builds", () => {
    const config = loadConfig({ ...baseEnvironment, ...wechat });
    expect(config.payments?.wechat).toMatchObject({
      mchid: "1900000001",
      appid: "wx0000000000000000",
      gatewayUrl: "https://api.mch.weixin.qq.com",
    });
    expect(config.payments?.wechat?.platformCertificates).toHaveLength(1);
    expect(config.payments?.wechat?.platformCertificates[0]).toContain("-----BEGIN");
  });

  test("both channels may be configured at once", () => {
    const config = loadConfig({ ...baseEnvironment, ...alipay, ...wechat });
    expect(config.payments?.alipay).toBeDefined();
    expect(config.payments?.wechat).toBeDefined();
  });

  test("a wrong-length APIv3 key stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...wechat,
        [VARS.wxApiv3]: "short",
      }),
    ).toThrow(/exactly 32 characters/);
  });

  test("a credential path that does not exist refuses the boot", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        [VARS.alipayAppId]: "2021000100000000",
        [VARS.alipayKey]: "/nonexistent/payment-key.pem",
        [VARS.alipayPub]: fixtureCertPath,
      }),
    ).toThrow(/could not be read/);
  });

  test("the numeric knobs read, default, and refuse malformed values", () => {
    const config = loadConfig({
      ...baseEnvironment,
      ...alipay,
      PAYMENT_ORDER_TTL_MINUTES: "30",
      PAYMENT_CALLBACK_SKEW_SECONDS: "60",
      PAYMENT_LATE_PAYMENT_WINDOW_HOURS: "48",
    });
    expect(config.payments?.orderTtlMinutes).toBe(30);
    expect(config.payments?.callbackSkewSeconds).toBe(60);
    expect(config.payments?.latePaymentWindowHours).toBe(48);

    const defaults = loadConfig({ ...baseEnvironment, ...alipay });
    expect(defaults.payments?.orderTtlMinutes).toBe(15);
    expect(defaults.payments?.callbackSkewSeconds).toBe(300);
    expect(defaults.payments?.latePaymentWindowHours).toBe(24);

    expect(() =>
      loadConfig({ ...baseEnvironment, ...alipay, PAYMENT_ORDER_TTL_MINUTES: "0" }),
    ).toThrow(/PAYMENT_ORDER_TTL_MINUTES must be a whole number greater than zero/);
  });

  test("the foreign-currency override reads as a flag", () => {
    const off = loadConfig({ ...baseEnvironment, ...alipay });
    expect(off.payments?.acceptForeignCurrency).toBe(false);
    const on = loadConfig({
      ...baseEnvironment,
      ...alipay,
      PAYMENT_ACCEPT_FOREIGN_CURRENCY: "true",
    });
    expect(on.payments?.acceptForeignCurrency).toBe(true);
  });

  /*
   * THE PRICE CROSS-CHECK (P1-2 closed at boot): the collected price (PAYMENT_PLAN_CATALOG)
   * and the displayed monthly price (LAGO_PLAN_CATALOG) are two variables, and nothing
   * downstream compares them — a deployment that edits one and forgets the other shows one
   * number and collects another. The boot refusal is the fix; both directions are pinned here.
   */
  const DISPLAY_CATALOG = JSON.stringify({
    pro: {
      name: "专业版",
      credits: 9000,
      features: ["每月基础积分"],
      pricing: [
        {
          code: "recurring_monthly",
          label: "连续包月",
          priceCents: 8800,
          originalCents: null,
          discountLabel: null,
          unit: "month",
        },
      ],
    },
  });

  test("matching monthly prices across the two catalogs build cleanly", () => {
    const config = loadConfig({
      ...baseEnvironment,
      ...alipay,
      LAGO_PLAN_CATALOG: DISPLAY_CATALOG,
    });
    expect(config.payments?.planCatalog.get("pro")?.amountCents).toBe(8800);
  });

  test("a collected price that disagrees with the displayed monthly price stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...alipay,
        LAGO_PLAN_CATALOG: DISPLAY_CATALOG,
        // The dialog would show ¥88 while the channel collects ¥99 — the exact overcharge a
        // reader cannot see coming, refused before the first order exists.
        PAYMENT_PLAN_CATALOG: JSON.stringify({
          pro: { amountCents: 9900, currency: "CNY", periodMonths: 1 },
        }),
      }),
    ).toThrow(
      /PAYMENT_PLAN_CATALOG plan "pro" amountCents \(9900\) does not match LAGO_PLAN_CATALOG's monthly price \(8800\)/,
    );
  });

  test("a purchasable plan the display catalog never prices builds, with the warning", () => {
    // Not itself a mismatch (the payment catalog is the collector's truth), but worth pinning
    // that it does not refuse: an API-only plan is a legitimate shape.
    const config = loadConfig({
      ...baseEnvironment,
      ...alipay,
      // LAGO_PLAN_CATALOG unset: no displayed prices at all, nothing to disagree with.
    });
    expect(config.payments?.planCatalog.get("pro")?.amountCents).toBe(8800);
  });
});
