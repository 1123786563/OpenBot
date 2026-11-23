/**
 * The pilot lead's switches for the paths credits travel (#108, #109, #111,
 * #112). Each command is one ledger method, and prints what it returned.
 *
 *   DATABASE_URL=… bun scripts/billing-paths.ts apps
 *   … register <id> --name <name> --operator platform|independent --prefix <resource prefix>
 *   … approve <id> --by <who>        an application takes reservations once approved
 *   … pause <id> --by <who>          its path takes no new reservation; the rest settles
 *   … resume <id>
 *   … provider-cost [set --microcredits <amount> --by <who>]
 *   … pending [--account <id>]       the orders still awaiting a channel result
 *   … close <order id> --by <who>    the channel says nobody paid
 *   … confirm-test-refund <order id> --returned-cents <amount>
 *   … dispute status <order id>
 *   … dispute open <order id> --by <operator> --reference <channel case>
 *   … dispute confirm-reversal <order id> --by <operator> --reference <verified reversal>
 *   … dispute reconcile <order id> --by <operator> --reference <finance record>
 *   … restore begin --by <who>       new charges and grants pause, account by account
 *   … restore order <order id> --account <id> --product <code> --cents <amount> --channel alipay|wechat
 *   … restore resume --account <id>  the account's records match the channel
 *   … restore end
 */
import { z } from "zod";
import {
  createPaidCreditLedger,
  type PaidCreditLedger,
} from "../src/billing/paid-ledger";
import {
  createTestCreditLedger,
  type TestCreditLedger,
} from "../src/billing/test-credit";
import { createDatabase } from "../src/db/client";

const usage =
  "bun scripts/billing-paths.ts apps | register <id> --name --operator --prefix | approve <id> --by | pause <id> --by | resume <id> | provider-cost [set --microcredits --by] | pending [--account] | close <order id> --by | confirm-test-refund <order id> --returned-cents | dispute status <order id> | dispute open|confirm-reversal|reconcile <order id> --by --reference | restore begin --by | restore order <order id> --account --product --cents --channel | restore resume --account | restore end";

export type BillingPaths = {
  credit: Pick<
    TestCreditLedger,
    | "applications"
    | "registerApplication"
    | "approveApplication"
    | "pauseApplication"
    | "resumeApplication"
    | "pilotProviderCost"
    | "setPilotProviderCostLimit"
  >;
  paid: Pick<
    PaidCreditLedger,
    | "handleDispute"
    | "disputeStatus"
    | "pendingOrders"
    | "closeOrder"
    | "confirmTestPackManualRefund"
    | "beginRestore"
    | "restoreOrder"
    | "resumeAccount"
    | "endRestore"
  >;
};

// Positional words, then `--flag value` pairs.
function parse(args: string[]) {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg?.startsWith("--")) {
      const value = args[index + 1];
      if (value && !value.startsWith("--")) {
        flags[arg.slice(2)] = value;
        index += 1;
      } else {
        flags[arg.slice(2)] = "";
      }
    } else if (arg) words.push(arg);
  }
  return { words, flags };
}

function need(flags: Record<string, string>, name: string) {
  const value = flags[name];
  if (!value) throw new TypeError(`--${name} is required.\n${usage}`);
  return value;
}

/** Runs one command and answers what the ledger returned. */
export async function run(
  args: string[],
  ledgers: BillingPaths,
): Promise<unknown> {
  const { words, flags } = parse(args);
  // The first word names a command, and `restore` names a second one after
  // it: `restore begin` and `resume <id>` are different commands.
  const [command, target, action] = words;
  const key = command === "restore" ? `restore ${target}` : command;
  const named = (value: string | undefined, name: string) => {
    if (!value) throw new TypeError(`The ${name} is required.\n${usage}`);
    return value;
  };
  const id = (name: string) => named(target, name);
  const by = () => need(flags, "by");
  const oneOf = <T extends string>(name: string, allowed: readonly T[]) => {
    const value = need(flags, name);
    if (!allowed.includes(value as T))
      throw new TypeError(
        `--${name} must be ${allowed.join(" or ")}.\n${usage}`,
      );
    return value as T;
  };
  switch (key) {
    case "apps":
      return ledgers.credit.applications();
    case "register":
      return ledgers.credit.registerApplication({
        id: id("application id"),
        name: need(flags, "name"),
        operator: oneOf("operator", ["platform", "independent"]),
        resourcePrefix: need(flags, "prefix"),
      });
    case "approve":
      return ledgers.credit.approveApplication(id("application id"), by());
    case "pause":
      return ledgers.credit.pauseApplication(id("application id"), by());
    case "resume":
      return ledgers.credit.resumeApplication(id("application id"));
    case "provider-cost": {
      if (!target) return ledgers.credit.pilotProviderCost();
      if (target !== "set" || action) throw new TypeError(usage);
      const amount = need(flags, "microcredits");
      if (!/^\d+$/.test(amount))
        throw new TypeError("--microcredits must be a nonnegative integer.");
      return ledgers.credit.setPilotProviderCostLimit({
        limitMicrocredits: BigInt(amount),
        by: by(),
      });
    }
    case "pending":
      return ledgers.paid.pendingOrders(flags.account);
    case "close":
      return ledgers.paid.closeOrder(id("order id"), by());
    case "confirm-test-refund": {
      if (action) throw new TypeError(usage);
      const amount = need(flags, "returned-cents");
      const returnedCents = Number(amount);
      if (!/^[1-9]\d*$/.test(amount) || !Number.isSafeInteger(returnedCents))
        throw new TypeError(
          `--returned-cents must be a positive whole amount.\n${usage}`,
        );
      return ledgers.paid.confirmTestPackManualRefund({
        orderId: id("order id"),
        returnedCents,
      });
    }
    case "dispute": {
      const orderId = z.uuid().parse(named(action, "order id"));
      if (target === "status") return ledgers.paid.disputeStatus(orderId);
      const disputeAction = z
        .enum(["open", "confirm-reversal", "reconcile"])
        .parse(target);
      const label = z.string().trim().min(1).max(256);
      return ledgers.paid.handleDispute({
        action: disputeAction,
        orderId,
        by: label.parse(by()),
        reference: label.parse(need(flags, "reference")),
      });
    }
    case "restore begin":
      return ledgers.paid.beginRestore(by());
    case "restore order": {
      const cents = Number(need(flags, "cents"));
      if (!Number.isInteger(cents) || cents <= 0)
        throw new TypeError(`--cents must be a whole amount.\n${usage}`);
      return ledgers.paid.restoreOrder({
        id: named(action, "order id"),
        accountId: need(flags, "account"),
        productCode: need(flags, "product"),
        priceCents: cents,
        channel: oneOf("channel", ["alipay", "wechat"]),
      });
    }
    case "restore resume":
      return ledgers.paid.resumeAccount(need(flags, "account"));
    case "restore end":
      return ledgers.paid.endRestore();
    default:
      throw new TypeError(usage);
  }
}

if (import.meta.main) {
  const database = createDatabase(process.env.DATABASE_URL ?? "");
  try {
    console.log(
      JSON.stringify(
        await run(process.argv.slice(2), {
          credit: createTestCreditLedger(database),
          paid: createPaidCreditLedger(database),
        }),
        (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        2,
      ) ?? "Done.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await database.$client.close();
  }
}
