import { describe, expect, test } from "bun:test";
import { cost, units } from "../../../src/enterprise/models/money";

/*
 * E4-B 金额算法（03 分册 §8.2 计划 780–790 行样例的真实半场）。
 *
 * 预算里的每个金额都是一种货币下的整数微单位（1 主单位 = 1,000,000 micros），
 * 以 BigInt 穿过整条链路：大数永远不经过 Number 取整，组合结果超过
 * int8 上限（PostgreSQL bigint）时显式溢出而不是静默回绕，负数与任何
 * 非十进制整数字面量在入口即拒绝。计划样例的两条断言原样保留。
 */

const INT8_MAX = 9223372036854775807n;

describe("units", () => {
  test("large amounts never round through Number", () => {
    /* 2^53+1 经 Number 会变成 2^53：这里必须逐位保留。 */
    expect(units("9007199254740993")).toBe(9007199254740993n);
    expect(cost(10n, 2n, 3n, 7n, 5n)).toBe(49n);
  });

  test("decimal strings parse exactly, including zero and int8 max", () => {
    expect(units("0")).toBe(0n);
    expect(units("1")).toBe(1n);
    expect(units("1000000")).toBe(1000000n);
    expect(units(INT8_MAX.toString())).toBe(INT8_MAX);
  });

  test("every non-canonical literal is refused as INVALID_MONEY", () => {
    for (const value of [
      "-1",
      "007",
      "1.5",
      "",
      " 1",
      "1 ",
      "+1",
      "1e3",
      "0x10",
      "abc",
      "１",
      "NaN",
      "Infinity",
    ]) {
      expect(() => units(value)).toThrow("INVALID_MONEY");
    }
  });

  test("anything past the int8 maximum overflows explicitly", () => {
    expect(() => units("9223372036854775808")).toThrow("MONEY_OVERFLOW");
    expect(() => units("99999999999999999999999")).toThrow("MONEY_OVERFLOW");
  });
});

describe("cost", () => {
  test("combines input, output and fixed micros as exact bigint math", () => {
    expect(cost(0n, 0n, 5n, 5n, 5n)).toBe(5n);
    expect(cost(1000000n, 500000n, 3n, 12n, 250n)).toBe(9000250n);
  });

  test("negative tokens, rates or fixed fee are refused", () => {
    expect(() => cost(-1n, 0n, 1n, 1n, 0n)).toThrow("INVALID_MONEY");
    expect(() => cost(0n, -1n, 1n, 1n, 0n)).toThrow("INVALID_MONEY");
    expect(() => cost(0n, 0n, -1n, 1n, 0n)).toThrow("INVALID_MONEY");
    expect(() => cost(0n, 0n, 1n, -1n, 0n)).toThrow("INVALID_MONEY");
    expect(() => cost(0n, 0n, 1n, 1n, -1n)).toThrow("INVALID_MONEY");
  });

  test("a combination exactly at int8 max still fits", () => {
    expect(cost(INT8_MAX, 0n, 1n, 1n, 0n)).toBe(INT8_MAX);
    expect(cost(0n, 0n, 0n, 0n, INT8_MAX)).toBe(INT8_MAX);
  });

  test("a combination past int8 max overflows instead of wrapping", () => {
    expect(() => cost(INT8_MAX, 1n, 1n, 1n, 0n)).toThrow("MONEY_OVERFLOW");
    expect(() => cost(2n, 0n, 4611686018427387904n, 0n, 0n)).toThrow(
      "MONEY_OVERFLOW",
    );
  });
});
