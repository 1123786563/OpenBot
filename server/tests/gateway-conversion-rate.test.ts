// Ticket #209 (Bifrost 01.3): the conversion rate is the one number that turns a model's dollar
// cost into credits, so it refuses to be guessed. Every rejection below names its reason, and the
// same pure parser must drive both the boot path (loadConfig) and the admin write path.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  billingReadiness,
  effectiveConversionRate,
  parseConversionRateInput,
} from "../src/gateway/conversion-rate";
import { testEnvironment } from "./support/environment";

const INVALID: { raw: string; reason: string }[] = [
  { raw: "0", reason: "zero" },
  { raw: "0.0", reason: "zero" },
  { raw: "00.000", reason: "zero" },
  { raw: "-1", reason: "negative" },
  { raw: "-0.5", reason: "negative" },
  { raw: "abc", reason: "invalid_format" },
  { raw: "1e3", reason: "invalid_format" },
  { raw: "1.2.3", reason: "invalid_format" },
  { raw: "+1", reason: "invalid_format" },
  { raw: ".5", reason: "invalid_format" },
  { raw: "1,5", reason: "invalid_format" },
  { raw: "1 2", reason: "invalid_format" },
  { raw: "١٢٣", reason: "invalid_format" },
  { raw: "1.1234567", reason: "precision_exceeded" },
  { raw: "0.0000001", reason: "precision_exceeded" },
  { raw: "1234567890", reason: "out_of_range" },
  { raw: "9999999999.1", reason: "out_of_range" },
];

describe("parseConversionRateInput", () => {
  test("missing input is refused with the no-implicit-default reason", () => {
    for (const raw of [undefined, "", "   "]) {
      const parsed = parseConversionRateInput(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe("missing");
        expect(parsed.message).toContain("no implicit default");
      }
    }
  });

  test.each(INVALID)("rejects %s with the specific reason %s", ({ raw, reason }) => {
    const parsed = parseConversionRateInput(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe(reason);
      expect(parsed.message.length).toBeGreaterThan(0);
    }
  });

  test("zero names positivity, not just shape", () => {
    const parsed = parseConversionRateInput("0");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("zero");
      expect(parsed.message).toContain("positive");
    }
  });

  test("precision rejections name the decimal cap", () => {
    const parsed = parseConversionRateInput("1.1234567");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("precision_exceeded");
      expect(parsed.message).toContain("6 decimal places");
    }
  });

  test("plain positive decimals parse to exact rationals, never floats", () => {
    expect(parseConversionRateInput("500")).toEqual({
      ok: true,
      value: { numerator: 500n, denominator: 1n },
    });
    expect(parseConversionRateInput("7.5")).toEqual({
      ok: true,
      value: { numerator: 75n, denominator: 10n },
    });
    expect(parseConversionRateInput("0.5")).toEqual({
      ok: true,
      value: { numerator: 5n, denominator: 10n },
    });
    expect(parseConversionRateInput(" 1.25 ")).toEqual({
      ok: true,
      value: { numerator: 125n, denominator: 100n },
    });
  });

  test("extreme but legal rates keep every digit exactly", () => {
    expect(parseConversionRateInput("0.000001")).toEqual({
      ok: true,
      value: { numerator: 1n, denominator: 1000000n },
    });
    expect(parseConversionRateInput("999999999.123456")).toEqual({
      ok: true,
      value: { numerator: 999999999123456n, denominator: 1000000n },
    });
  });
});

describe("boot-time configuration (loadConfig)", () => {
  test("absent rate leaves billing unconfigured, no default is invented", () => {
    const config = loadConfig(testEnvironment());
    expect(config.bifrostConversionRate).toBeUndefined();
  });

  test.each(INVALID)(
    "process start refuses %s with the same reason as the parser",
    ({ raw }) => {
      const parsed = parseConversionRateInput(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(() =>
          loadConfig(testEnvironment({ BIFROST_CREDITS_PER_USD: raw })),
        ).toThrow(`BIFROST_CREDITS_PER_USD`);
        // The startup refusal must carry the parser's reason, not a generic one.
        try {
          loadConfig(testEnvironment({ BIFROST_CREDITS_PER_USD: raw }));
        } catch (error) {
          expect((error as Error).message).toContain(
            reasonSpecificFragment(parsed.message),
          );
        }
      }
    },
  );

  test("a valid rate reaches the config as an exact rational", () => {
    const config = loadConfig(
      testEnvironment({ BIFROST_CREDITS_PER_USD: "123.456" }),
    );
    expect(config.bifrostConversionRate).toEqual({
      numerator: 123456n,
      denominator: 1000n,
    });
  });
});

/** The shared core of a parser message, stable across both enforcement paths. */
function reasonSpecificFragment(message: string): string {
  // Parser messages are single sentences; the fragment before the first comma/names the rule.
  return message.split(",")[0]!.split("(")[0]!.trim();
}

describe("effective rate and billing readiness", () => {
  test("nothing stored and no boot rate means billing is explicitly not enabled", () => {
    const status = effectiveConversionRate(
      { configured: false, reason: "not_configured" },
      undefined,
    );
    expect(status.configured).toBe(false);
    const gate = billingReadiness(status);
    expect(gate.billingEnabled).toBe(false);
    if (!gate.billingEnabled) {
      expect(gate.reasonCode).toBe("conversion_rate_missing");
      expect(gate.detail.length).toBeGreaterThan(0);
    }
  });

  test("a boot rate counts as configured at rateVersion 0", () => {
    const status = effectiveConversionRate(
      { configured: false, reason: "not_configured" },
      { numerator: 75n, denominator: 10n },
    );
    expect(status).toEqual({
      configured: true,
      config: { numerator: 75n, denominator: 10n, rateVersion: 0 },
    });
    expect(billingReadiness(status)).toEqual({
      billingEnabled: true,
      rate: { numerator: 75n, denominator: 10n },
      rateVersion: 0,
    });
  });

  test("a stored admin row outranks the boot rate", () => {
    const status = effectiveConversionRate(
      {
        configured: true,
        config: { numerator: 1n, denominator: 1n, rateVersion: 3 },
      },
      { numerator: 75n, denominator: 10n },
    );
    expect(status.configured && status.config.rateVersion).toBe(3);
    expect(status.configured && status.config.numerator).toBe(1n);
  });

  test("an invalid stored value keeps billing unavailable instead of guessing a rate", () => {
    const status = effectiveConversionRate(
      { configured: false, reason: "invalid" },
      { numerator: 75n, denominator: 10n },
    );
    // A tampered or unreadable stored row must not silently fall back to the boot rate.
    expect(status.configured).toBe(false);
    const gate = billingReadiness(status);
    expect(gate.billingEnabled).toBe(false);
    if (!gate.billingEnabled) {
      expect(gate.reasonCode).toBe("conversion_rate_invalid");
    }
  });
});
