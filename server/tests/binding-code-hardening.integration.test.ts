import { afterAll, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createFailureLimiter } from "../src/bot-services/auth";
import {
  BindingCodeRateLimitedError,
  BindingCodeRejectedError,
  bindingCodeHash,
  createBindingOfferConsumer,
  createBindingOfferIssuer,
  mintBindingCode,
} from "../src/bot-services/binding-codes";
import { createBotServiceStore } from "../src/bot-services/store";
import { BotServiceInputError } from "../src/bot-services/types";
import { createDatabase } from "../src/db/client";
import { botBindingOffers } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost #237 (04.4): binding-code consumption hardening, on a real PostgreSQL.
 *
 * The questions here are the ticket's own: consuming the same code twice — concurrently or
 * sequentially — succeeds exactly once; a forged, expired, replayed or cross-bot presentation is
 * refused, and every refusal is the same refusal, saying nothing about whether the code exists,
 * whom it belongs to or which of the four it was; and a source that keeps failing is locked out
 * while everyone else is left alone.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** Registration only, no credential: consumption is a data operation, not an authenticated door. */
const registry = createBotServiceStore(database);
const issuer = createBindingOfferIssuer({ database });
/** The consumer under its default limiter — thresholds never bind in these tests. */
const consumer = createBindingOfferConsumer({ database });
const prefix = `b5-237-${randomUUID()}`;

afterAll(async () => {
  // Offers first (they name a bot). The bot_services rows stay behind, as every run of this
  // suite's own issuance tests leaves its own: botIds are per-run and never conflict, and rows
  // are never deleted by design.
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database.$client.close();
});

/** A botId under this file's prefix, registered so offer rows satisfy their foreign key. */
async function registeredBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: "Hardening Bot",
    kind: "external",
    capabilities: ["chat"],
  });
  return botId;
}

/** Issue one live offer and hand back only its plaintext code, the way a Bot's server holds it. */
async function issueCode(botId: string, hint = "slack:U1") {
  const offer = await issuer.issue(
    { botId, status: "active" },
    { externalIdentityHint: hint },
  );
  return offer.bindingCode;
}

/** The error a failed promise settled with, or a loud failure of the test's own. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the consumption to fail");
}

/** The stored row behind one code, by the only key consumption ever looks it up under. */
async function rowFor(code: string) {
  const [row] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.codeHash, bindingCodeHash(code)));
  return row;
}

test("consuming the same code concurrently succeeds exactly once", async () => {
  const botId = await registeredBot("race");
  const code = await issueCode(botId, "slack:race");

  const outcomes = await Promise.allSettled([
    consumer.consume(code, { source: "racer-a" }),
    consumer.consume(code, { source: "racer-b" }),
  ]);
  const wins = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? [outcome.value] : [],
  );
  const losses = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as Error] : [],
  );
  expect(wins).toHaveLength(1);
  expect(losses).toHaveLength(1);
  // The loser's refusal is the same uniform one, not a special "someone beat you" answer.
  expect(losses[0]).toBeInstanceOf(BindingCodeRejectedError);
  // The winner holds the consumed offer and nothing more.
  expect(wins[0].botId).toBe(botId);
  expect(wins[0].status).toBe("redeemed");

  // The row is terminal, so a third, sequential attempt cannot succeed either.
  await expect(
    consumer.consume(code, { source: "racer-c" }),
  ).rejects.toBeInstanceOf(BindingCodeRejectedError);
  expect((await rowFor(code)).status).toBe("redeemed");
});

test("forged, expired, replayed and cross-bot codes are all refused the same way", async () => {
  const botA = await registeredBot("classes-a");
  const botB = await registeredBot("classes-b");
  const rejections: Error[] = [];

  // Forged: a well-shaped code nobody ever issued.
  rejections.push(
    await failureOf(consumer.consume(mintBindingCode(), { source: "enum-1" })),
  );

  // Expired: a row whose expires_at is already past, read through the same public path.
  const expiredCode = mintBindingCode();
  await database.insert(botBindingOffers).values({
    codeHash: bindingCodeHash(expiredCode),
    botId: botA,
    externalIdentityHint: "slack:expired",
    singleUse: true,
    status: "pending",
    issuedAt: new Date(Date.now() - 120_000),
    expiresAt: new Date(Date.now() - 60_000),
  });
  rejections.push(
    await failureOf(consumer.consume(expiredCode, { source: "enum-1" })),
  );

  // Replayed: consumed once, then presented again.
  const replayedCode = await issueCode(botA, "slack:replayed");
  const first = await consumer.consume(replayedCode, { source: "enum-1" });
  expect(first.status).toBe("redeemed");
  rejections.push(
    await failureOf(consumer.consume(replayedCode, { source: "enum-1" })),
  );

  // Cross-bot: a code bound to botA, presented pinned to botB.
  const crossCode = await issueCode(botA, "slack:cross");
  rejections.push(
    await failureOf(
      consumer.consume(crossCode, { source: "enum-1", botId: botB }),
    ),
  );

  // One class, one message, no data fields beyond the class name: an observer cannot tell
  // which failure it was, whom the code belonged to, or whether it existed.
  for (const error of rejections) {
    expect(error).toBeInstanceOf(BindingCodeRejectedError);
    expect(error.message).toBe("The binding code was not accepted.");
    expect(Object.keys(error)).toEqual(["name"]);
  }
  expect(
    new Set(
      rejections.map((error) =>
        JSON.stringify({ name: error.name, message: error.message }),
      ),
    ).size,
  ).toBe(1);
});

test("a cross-bot refusal does not spend the code, and the consumed answer carries no code material", async () => {
  const botA = await registeredBot("pin-a");
  const botB = await registeredBot("pin-b");
  const code = await issueCode(botA, "slack:pin");

  await expect(
    consumer.consume(code, { source: "pin-1", botId: botB }),
  ).rejects.toBeInstanceOf(BindingCodeRejectedError);

  const consumed = await consumer.consume(code, {
    source: "pin-1",
    botId: botA,
  });
  // The whole produced contract on success, and nothing more.
  expect(consumed).toEqual({
    botId: botA,
    externalIdentityHint: "slack:pin",
    singleUse: true,
    status: "redeemed",
  });
});

test("repeated failures lock the source, and the lock touches nobody else", async () => {
  let clock = 1_000_000_000;
  const strict = createBindingOfferConsumer({
    database,
    limiter: createFailureLimiter({
      maxFailures: 3,
      windowMs: 60_000,
      now: () => clock,
    }),
  });
  const botId = await registeredBot("lock");

  for (let i = 0; i < 3; i++) {
    await expect(
      strict.consume(mintBindingCode(), { source: "attacker" }),
    ).rejects.toBeInstanceOf(BindingCodeRejectedError);
  }

  // Locked — a genuinely valid code presented by the locked source is still refused.
  const validCode = await issueCode(botId, "slack:lock");
  await expect(
    strict.consume(validCode, { source: "attacker" }),
  ).rejects.toBeInstanceOf(BindingCodeRateLimitedError);

  // A different source is untouched: it consumes that same code without trouble.
  const consumed = await strict.consume(validCode, { source: "someone-else" });
  expect(consumed.status).toBe("redeemed");

  // The window drains on its own; past it the same source may try again and succeed.
  clock += 60_001;
  const freshCode = await issueCode(botId, "slack:lock-2");
  const after = await strict.consume(freshCode, { source: "attacker" });
  expect(after.status).toBe("redeemed");
});

test("each code is consumed on its own: a sibling offer for the same bot and identity survives", async () => {
  const botId = await registeredBot("sibling");
  const first = await issueCode(botId, "slack:same");
  const second = await issueCode(botId, "slack:same");

  const consumed = await consumer.consume(first, { source: "sib-1" });
  expect(consumed.status).toBe("redeemed");

  const rows = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.botId, botId));
  expect(rows).toHaveLength(2);
  expect(
    rows.find((row) => row.codeHash === bindingCodeHash(first))?.status,
  ).toBe("redeemed");
  expect(
    rows.find((row) => row.codeHash === bindingCodeHash(second))?.status,
  ).toBe("pending");

  const sibling = await consumer.consume(second, { source: "sib-1" });
  expect(sibling.status).toBe("redeemed");
});

test("consumption rides the caller's transaction: a rollback leaves the offer spendable", async () => {
  const botId = await registeredBot("caller-tx");
  const code = await issueCode(botId, "slack:tx");

  const rolled = await database
    .transaction(async (transaction) => {
      const consumed = await consumer.consume(
        code,
        { source: "tx-1" },
        transaction,
      );
      expect(consumed.botId).toBe(botId);
      throw new Error("the caller's later work failed");
    })
    .catch(() => "rolled back");
  expect(rolled).toBe("rolled back");

  expect((await rowFor(code)).status).toBe("pending");
  const retried = await consumer.consume(code, { source: "tx-1" });
  expect(retried.status).toBe("redeemed");
});

test("a presentation that is not even shaped like one is refused as input, and spends nothing", async () => {
  const botId = await registeredBot("input");
  const code = await issueCode(botId, "slack:input");

  await expect(
    consumer.consume("", { source: "input-1" }),
  ).rejects.toBeInstanceOf(BotServiceInputError);
  await expect(consumer.consume(code, { source: "" })).rejects.toBeInstanceOf(
    BotServiceInputError,
  );

  // Whitespace padding is not stripped into a match: it is simply no code we issued.
  await expect(
    consumer.consume(` ${code} `, { source: "input-1" }),
  ).rejects.toBeInstanceOf(BindingCodeRejectedError);

  // Nothing was counted or consumed along the way.
  expect((await rowFor(code)).status).toBe("pending");
});
