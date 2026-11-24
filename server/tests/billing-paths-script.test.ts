import { expect, test } from "bun:test";
import { run, type BillingPaths } from "../scripts/billing-paths";

/**
 * The pilot lead's switches (`bun scripts/billing-paths.ts`): each command
 * reaches its ledger method with its arguments, and a command that is not
 * one of them never reaches a ledger at all.
 */

const calls: [string, ...unknown[]][] = [];
const record =
  (name: string) =>
  (...args: unknown[]) => {
    calls.push([name, ...args]);
    return { name };
  };
const ledgers = {
  credit: {
    applications: record("applications"),
    registerApplication: record("register"),
    approveApplication: record("approve"),
    pauseApplication: record("pause"),
    resumeApplication: record("resume"),
  },
  paid: {
    pendingOrders: record("pending"),
    closeOrder: record("close"),
    beginRestore: record("beginRestore"),
    restoreOrder: record("restoreOrder"),
    resumeAccount: record("resumeAccount"),
    endRestore: record("endRestore"),
  },
} as unknown as BillingPaths;

test("each command reaches its ledger method with its arguments", async () => {
  for (const args of [
    ["apps"],
    [
      "register",
      "weknora",
      "--name",
      "WeKnora",
      "--operator",
      "platform",
      "--prefix",
      "kb-",
    ],
    ["approve", "weknora", "--by", "pilot-lead"],
    ["pause", "weknora", "--by", "pilot-lead"],
    ["resume", "weknora"],
    ["pending"],
    ["pending", "--account", "account-1"],
    ["close", "order-1", "--by", "pilot-lead"],
    ["restore", "begin", "--by", "operator"],
    [
      "restore",
      "order",
      "order-1",
      "--account",
      "account-1",
      "--product",
      "pack-monthly",
      "--cents",
      "9900",
      "--channel",
      "alipay",
    ],
    ["restore", "resume", "--account", "account-1"],
    ["restore", "end"],
  ])
    expect(await run(args, ledgers)).toBeDefined();

  expect(calls).toEqual([
    ["applications"],
    [
      "register",
      {
        id: "weknora",
        name: "WeKnora",
        operator: "platform",
        resourcePrefix: "kb-",
      },
    ],
    ["approve", "weknora", "pilot-lead"],
    ["pause", "weknora", "pilot-lead"],
    ["resume", "weknora"],
    ["pending", undefined],
    ["pending", "account-1"],
    ["close", "order-1", "pilot-lead"],
    ["beginRestore", "operator"],
    [
      "restoreOrder",
      {
        id: "order-1",
        accountId: "account-1",
        productCode: "pack-monthly",
        priceCents: 9_900,
        channel: "alipay",
      },
    ],
    ["resumeAccount", "account-1"],
    ["endRestore"],
  ]);
});

test("a command that is not one of these never reaches a ledger", async () => {
  calls.length = 0;
  for (const args of [
    [],
    ["nonsense"],
    ["approve", "weknora"],
    ["pause"],
    [
      "register",
      "weknora",
      "--name",
      "WeKnora",
      "--operator",
      "someone",
      "--prefix",
      "kb-",
    ],
    ["close", "order-1"],
    ["restore", "begin"],
    ["restore", "order", "--account", "account-1"],
    [
      "restore",
      "order",
      "order-1",
      "--account",
      "account-1",
      "--product",
      "pack-monthly",
      "--cents",
      "9.5",
      "--channel",
      "alipay",
    ],
    [
      "restore",
      "order",
      "order-1",
      "--account",
      "account-1",
      "--product",
      "pack-monthly",
      "--cents",
      "9900",
      "--channel",
      "paypal",
    ],
    ["restore", "resume"],
  ])
    await expect(run(args, ledgers)).rejects.toThrow(
      "bun scripts/billing-paths.ts",
    );
  expect(calls).toEqual([]);
});
