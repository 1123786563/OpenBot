import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../credentials";
import type { Database } from "../../../db/client";
import {
  slackPilotConnections as connections,
  slackPilotDefaults as defaults,
  slackPilotStates as states,
} from "../../../db/schema/corsair-slack";
import { corsairAccounts } from "../../../db/schema/corsair-storage";
import { brokeredAccounts } from "../../../db/schema/plugins";
import {
  canReconnect,
  clearRevocation,
  createRevocation,
  derivedAccountKeys,
  dispatchWhileConnected,
} from "../revocation";
import { SlackIdentityMismatch, type SlackPilotProvider } from "./provider";

const evidence = z.strictObject({
  workspaceId: z.string().min(1),
  registration: z.string().min(1),
  personId: z.string().min(1),
  brokeredAccountId: z.uuid(),
  subjectScope: z.string().regex(/^[TE][A-Z0-9]+$/),
  userId: z.string().regex(/^[UW][A-Z0-9]+$/),
  evidenceRef: z.string().trim().min(1).max(256),
});
export type SlackLegacyDefault = z.infer<typeof evidence>;
export function readSlackLegacyDefaults(
  raw: string | undefined,
): SlackLegacyDefault[] {
  if (!raw?.trim()) return [];
  try {
    return z.array(evidence).parse(JSON.parse(raw));
  } catch {
    throw new Error("Invalid CORSAIR_SLACK_VERIFIED_LEGACY_DEFAULTS records.");
  }
}

export class SlackPilotRefusal extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409 | 502,
  ) {
    super(message);
  }
}

type AccountOptions = {
  workspaceId: string;
  registration: string;
  database: Database;
  provider: SlackPilotProvider;
  encryptionKey: string;
  clock: () => Date;
  legacyDefaults: readonly SlackLegacyDefault[];
};
const sha256 = (state: string) =>
  createHash("sha256").update(state).digest("hex");
const storedTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
const publicIdentity = {
  id: connections.id,
  subjectScope: connections.subjectScope,
  userId: connections.userId,
  label: connections.label,
  expiresAt: connections.expiresAt,
  verificationRequiredAt: connections.verificationRequiredAt,
};

export function slackAccounts({
  workspaceId,
  registration,
  database,
  provider,
  encryptionKey,
  clock,
  legacyDefaults,
}: AccountOptions) {
  const owner = (personId: string) => ({ workspaceId, registration, personId });
  const scope = (personId: string) =>
    and(
      eq(connections.workspaceId, workspaceId),
      eq(connections.registration, registration),
      eq(connections.personId, personId),
      eq(connections.subjectScope, provider.subjectScope),
    );
  const bound = (personId: string, id: string) =>
    and(scope(personId), eq(connections.id, id));
  const sealed = (value: z.infer<typeof storedTokens>) =>
    encryptSecret(encryptionKey, JSON.stringify(storedTokens.parse(value)));
  const expiry = (seconds: number) =>
    new Date(clock().getTime() + seconds * 1000);
  async function find(
    personId: string,
    id: string,
    tx?: Parameters<Parameters<Database["transaction"]>[0]>[0],
  ) {
    const query = (tx ?? database)
      .select()
      .from(connections)
      .where(bound(personId, id));
    const [connection] = await (tx ? query.for("share") : query);
    if (!connection)
      throw new SlackPilotRefusal("This Slack Connection is unavailable.", 403);
    if (connection.verificationRequiredAt)
      throw new SlackPilotRefusal(
        "Reauthorize this Slack Connection to verify its identity.",
        409,
      );
    return connection;
  }
  async function defaultConnectionId(personId: string) {
    const [record] = await database
      .select({ id: defaults.connectionId })
      .from(defaults)
      .innerJoin(connections, eq(connections.id, defaults.connectionId))
      .where(
        and(
          eq(defaults.workspaceId, workspaceId),
          eq(defaults.registration, registration),
          eq(defaults.personId, personId),
        ),
      );
    return record?.id ?? null;
  }
  return {
    find,
    defaultConnectionId,
    revocationScope: and(
      eq(corsairAccounts.kind, "slack-personal"),
      eq(corsairAccounts.workspaceId, workspaceId),
      eq(corsairAccounts.registration, registration),
      eq(corsairAccounts.subjectScope, provider.subjectScope),
    ),
    revocation: createRevocation({
      database,
      clock,
      async verify(account, capability) {
        if (!account.credential) return false;
        const tokens = storedTokens.parse(
          JSON.parse(await decryptSecret(encryptionKey, account.credential)),
        );
        return provider.revoke(
          capability === "access" ? tokens.accessToken : tokens.refreshToken,
        );
      },
    }),
    async list(personId: string) {
      return {
        connections: await database
          .select(publicIdentity)
          .from(connections)
          .where(scope(personId))
          .orderBy(connections.label, connections.id),
        defaultConnectionId: await defaultConnectionId(personId),
      };
    },
    async setDefault(personId: string, connectionId: string) {
      await find(personId, connectionId);
      await database
        .insert(defaults)
        .values({ ...owner(personId), connectionId })
        .onConflictDoUpdate({
          target: [
            defaults.storageKind,
            defaults.workspaceId,
            defaults.registration,
            defaults.personId,
          ],
          set: { connectionId },
        });
    },
    async start(personId: string) {
      const state = randomBytes(32).toString("base64url");
      await database
        .delete(states)
        .where(
          and(
            eq(states.workspaceId, workspaceId),
            eq(states.registration, registration),
            eq(states.personId, personId),
            lt(states.expiresAt, clock()),
          ),
        );
      await database.insert(states).values({
        ...owner(personId),
        stateHash: sha256(state),
        expiresAt: expiry(600),
      });
      return provider.authorizationUrl(state);
    },
    async connect(personId: string, state: string, code: string) {
      const [pending] = await database
        .delete(states)
        .where(
          and(
            eq(states.stateHash, sha256(state)),
            eq(states.workspaceId, workspaceId),
            eq(states.personId, personId),
            eq(states.registration, registration),
            gt(states.expiresAt, clock()),
          ),
        )
        .returning({ expiresAt: states.expiresAt });
      if (!pending)
        throw new SlackPilotRefusal(
          "This Slack authorization attempt is invalid, expired, or already used.",
          409,
        );
      const verified = await provider.exchange(code).catch(() => {
        throw new SlackPilotRefusal(
          "Slack could not verify the authorized installation and user.",
          502,
        );
      });
      const subjectScope = provider.subjectScope;
      const update = {
        label: verified.label,
        credential: await sealed(verified),
        expiresAt: expiry(verified.expiresIn),
        revision: randomUUID(),
        verificationRequiredAt: null,
      };
      const matchingEvidence = legacyDefaults.filter(
        (entry) =>
          entry.workspaceId === workspaceId &&
          entry.registration === registration &&
          entry.personId === personId,
      );
      const [record] = matchingEvidence;
      return database.transaction(async (tx) => {
        const [saved] = await tx
          .insert(corsairAccounts)
          .values({
            ...derivedAccountKeys,
            kind: "slack-personal",
            ...owner(personId),
            subjectScope,
            userId: verified.userId,
            ...update,
          })
          .onConflictDoUpdate({
            target: [
              corsairAccounts.kind,
              corsairAccounts.workspaceId,
              corsairAccounts.registration,
              corsairAccounts.personId,
              corsairAccounts.subjectScope,
              corsairAccounts.userId,
            ],
            set: { ...update, config: clearRevocation },
            setWhere: canReconnect(
              new Date(pending.expiresAt.getTime() - 600_000),
            ),
          })
          .returning({ id: corsairAccounts.id });
        if (!saved)
          throw new SlackPilotRefusal(
            "Finish the pending revocation before reconnecting.",
            409,
          );
        const [connection] = await tx
          .select(publicIdentity)
          .from(connections)
          .where(eq(connections.id, saved.id));
        if (!connection) throw new Error("Slack Connection was not saved.");
        if (
          matchingEvidence.length !== 1 ||
          record?.subjectScope !== subjectScope ||
          record.userId !== verified.userId
        )
          return { connection };
        const [legacy] = await tx
          .select({ id: brokeredAccounts.id })
          .from(brokeredAccounts)
          .where(
            and(
              eq(brokeredAccounts.id, record.brokeredAccountId),
              eq(brokeredAccounts.userId, personId),
              eq(brokeredAccounts.app, "slack"),
              eq(brokeredAccounts.isDefault, true),
            ),
          )
          .for("share");
        if (!legacy) return { connection };
        const [inherited] = await tx
          .insert(defaults)
          .values({ ...owner(personId), connectionId: connection.id })
          .onConflictDoNothing()
          .returning({ connectionId: defaults.connectionId });
        return {
          connection,
          inheritedFrom: inherited ? record.evidenceRef : undefined,
        };
      });
    },
    async verifiedToken(
      personId: string,
      connectionId: string,
      revision: string,
    ) {
      const result = await database.transaction(async (tx) => {
        // Rotation consumes the refresh credential. Serialize rotation for this Connection only.
        const [connection] = await tx
          .select()
          .from(connections)
          .where(bound(personId, connectionId))
          .for("update");
        if (
          !connection ||
          connection.revision !== revision ||
          connection.verificationRequiredAt
        )
          return { kind: "changed" as const };
        const tokens = storedTokens.parse(
          JSON.parse(await decryptSecret(encryptionKey, connection.credential)),
        );
        if (connection.expiresAt.getTime() - clock().getTime() > 60_000)
          return {
            kind: "current" as const,
            token: tokens.accessToken,
            userId: connection.userId,
          };
        try {
          const updated = await provider.refresh(
            tokens.refreshToken,
            connection.userId,
          );
          await tx
            .update(connections)
            .set({
              credential: await sealed(updated),
              expiresAt: expiry(updated.expiresIn),
              label: updated.label,
            })
            .where(bound(personId, connectionId));
          return { kind: "verified" as const, token: updated.accessToken };
        } catch {
          await tx
            .update(connections)
            .set({ verificationRequiredAt: clock() })
            .where(bound(personId, connectionId));
          return { kind: "unverified" as const };
        }
      });
      if (result.kind === "changed")
        throw new SlackPilotRefusal("The Slack authorization changed.", 409);
      if (result.kind === "unverified")
        throw new SlackPilotRefusal(
          "Reauthorize this Slack Connection to verify its identity.",
          409,
        );
      if (result.kind === "current") {
        try {
          await dispatchWhileConnected(database, connectionId, revision, () =>
            provider.identity(result.token, result.userId),
          );
        } catch (error) {
          if (error instanceof SlackIdentityMismatch)
            await database
              .update(connections)
              .set({ verificationRequiredAt: clock() })
              .where(
                and(
                  bound(personId, connectionId),
                  eq(connections.revision, revision),
                ),
              );
          throw new SlackPilotRefusal(
            "Slack could not verify the authorized user.",
            409,
          );
        }
      }
      return result.token;
    },
  };
}
