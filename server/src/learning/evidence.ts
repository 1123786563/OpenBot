import { createHash } from "node:crypto";
import type {
  DirectChatLearningScope,
  LearningEvidenceSelection,
} from "@openbot/shared/direct-chat-learning";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { ProfileReadExecutor } from "../agents/profile-store";
import type { Database } from "../db/client";
import {
  directChatAnalyses as analyses,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  directChatRuns,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings as mappings,
  recorderRecordingEvents,
  recorderRecordings,
  directChatProposalReviews as reviews,
} from "../db/schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function withdrawLearningEvidence(
  tx: Transaction,
  actorUserId: string,
  source: LearningEvidenceSelection,
  includeDestination = false,
) {
  const sourceKey = sql`jsonb_build_object('kind', ${source.kind}::text, 'id', ${source.id}::text)`;
  const matchingSource = sql`${analyses.evidenceSources} @> jsonb_build_array(${sourceKey})`;
  const removeSource = sql`coalesce((
    select jsonb_agg(item order by ordinal)
    from jsonb_array_elements(${analyses.evidenceSources}) with ordinality as sources(item, ordinal)
    where not (item @> ${sourceKey})
  ), '[]'::jsonb)`;
  const rows = await tx
    .select({ id: analyses.id, state: analyses.state })
    .from(analyses)
    .where(
      and(
        or(
          inArray(analyses.state, ["proposed", "running", "reconciling"]),
          eq(analyses.reason, "evidence_withdrawn"),
        ),
        includeDestination
          ? sql`(${analyses.threadId} in (select thread_id from ${mappings} where channel_id = ${source.id})
              or ${matchingSource})`
          : matchingSource,
      ),
    )
    .orderBy(asc(analyses.id))
    .for("update");
  if (!rows.length) return;
  await tx
    .update(analyses)
    .set({
      state: "cancelled",
      reason: sql`case when ${analyses.state} in ('running', 'reconciling')
      then 'evidence_unavailable' else 'evidence_withdrawn' end`,
      proposal: null,
      updatedAt: sql`now()`,
      evidenceSources: removeSource,
    })
    .where(
      inArray(
        analyses.id,
        rows.map(({ id }) => id),
      ),
    );
  const affected = rows.filter(({ state }) => state !== "cancelled");
  const published = affected.length
    ? await tx
        .select({ id: reviews.proposalId })
        .from(reviews)
        .where(
          and(
            inArray(
              reviews.proposalId,
              affected.map(({ id }) => id),
            ),
            sql`${reviews.review}->>'decision' = 'approve'`,
          ),
        )
    : [];
  await tx.insert(auditEvents).values([
    ...rows.map(({ id }) => ({
      actorUserId,
      eventType: "learning.evidence_withdrawn",
      targetType: "learning_proposal",
      targetId: id,
      payload: { source },
    })),
    ...published.map(({ id }) => ({
      actorUserId,
      eventType: "learning.skill_paused",
      targetType: "learning_proposal",
      targetId: id,
      payload: { source },
    })),
  ]);
}

async function conversationEvidence(
  tx: ProfileReadExecutor,
  scope: DirectChatLearningScope,
  id: string,
  cutoff: Date,
) {
  const [channel] = await tx
    .select({ name: channels.name })
    .from(channels)
    .innerJoin(
      channelAgents,
      and(
        eq(channelAgents.channelId, id),
        eq(channelAgents.agentId, scope.botId),
      ),
    )
    .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
    .for("share", { of: channels });
  if (!channel) return null;
  const members = await tx
    .select()
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, id))
    .for("share");
  if (!members.some(({ userId }) => userId === scope.personId)) return null;

  const [group] = await tx
    .select({ id: groupBotThreads.channelId })
    .from(groupBotThreads)
    .where(eq(groupBotThreads.channelId, id))
    .limit(1);
  if (!group) {
    if (members.length !== 1) return null;
    const turns = await tx
      .select({ prompt: directChatRuns.prompt, reply: directChatRuns.reply })
      .from(directChatRuns)
      .innerJoin(
        mappings,
        and(
          eq(mappings.threadId, directChatRuns.threadId),
          eq(mappings.channelId, id),
          eq(mappings.userId, scope.personId),
        ),
      )
      .where(
        and(
          isNotNull(directChatRuns.reply),
          eq(directChatRuns.status, "completed"),
          lte(directChatRuns.startedAt, cutoff),
        ),
      )
      .orderBy(desc(directChatRuns.startedAt), desc(directChatRuns.id))
      .limit(4);
    return turns.length
      ? {
          excerpt: turns
            .reverse()
            .map(
              ({ prompt, reply }) =>
                `Person: ${prompt.slice(0, 300)}\nBot: ${(reply ?? "").slice(0, 300)}`,
            )
            .join("\n"),
          title: channel.name,
        }
      : null;
  }

  if (members.some(({ learningEvidenceAllowed }) => !learningEvidenceAllowed))
    return null;
  // Bot replies can repeat earlier turns, including turns by a person who has left.
  const authors = await tx
    .select({ id: groupMessages.ownerUserId })
    .from(groupMessages)
    .where(
      and(
        eq(groupMessages.channelId, id),
        lte(groupMessages.createdAt, cutoff),
      ),
    )
    .groupBy(groupMessages.ownerUserId);
  if (authors.some(({ id }) => !members.some(({ userId }) => userId === id)))
    return null;

  const messages = await tx
    .select({ text: groupMessages.text, agentId: groupMessages.agentId })
    .from(groupMessages)
    .where(
      and(
        eq(groupMessages.channelId, id),
        eq(groupMessages.status, "completed"),
        lte(groupMessages.createdAt, cutoff),
      ),
    )
    .orderBy(desc(groupMessages.createdAt), desc(groupMessages.id))
    .limit(8);
  if (!messages.some(({ agentId }) => agentId === scope.botId)) return null;
  return {
    excerpt: messages
      .reverse()
      .map(
        ({ text, agentId }) =>
          `${agentId ? "Bot" : "Person"}: ${text.slice(0, 300)}`,
      )
      .join("\n"),
    title: channel.name,
  };
}

const recordingTarget = z.object({
  label: z.string().optional(),
  name: z.string().optional(),
  tag: z.string().optional(),
});

async function recordingEvidence(
  tx: ProfileReadExecutor,
  personId: string,
  id: string,
) {
  const [recording] = await tx
    .select({
      title: recorderRecordings.title,
      end: recorderRecordings.outcomeSeq,
    })
    .from(recorderRecordings)
    .where(
      and(
        eq(recorderRecordings.id, id),
        eq(recorderRecordings.userId, personId),
        isNull(recorderRecordings.deletedAt),
        eq(recorderRecordings.outcome, "succeeded"),
        isNotNull(recorderRecordings.outcomeSeq),
      ),
    )
    .for("share");
  if (recording?.end == null) return null;
  // Recorder rows written with ordinary Drizzle jsonb can contain a JSON-encoded string.
  const event = recorderRecordingEvents.event;
  const eventName = sql`(case when jsonb_typeof(${event}) = 'string'
    then (${event} #>> '{}')::jsonb else ${event} end)->>'name'`;
  const steps = await tx
    .select({ event: recorderRecordingEvents.event })
    .from(recorderRecordingEvents)
    .where(
      and(
        eq(recorderRecordingEvents.recordingId, id),
        lte(recorderRecordingEvents.seq, recording.end),
        sql`${eventName} in ('click', 'input', 'submit', 'key')`,
      ),
    )
    .orderBy(asc(recorderRecordingEvents.seq))
    .limit(12);
  if (!steps.length) return null;
  return {
    excerpt: steps
      .map(({ event }) => {
        const { label, tagName, target } = event.value;
        const parsed = recordingTarget.safeParse(target).data;
        const description = [
          parsed?.label,
          parsed?.name,
          label,
          parsed?.tag,
          tagName,
        ].find((value) => typeof value === "string" && value.trim().length > 0);
        return typeof description === "string"
          ? `${event.name}: ${description.slice(0, 180)}`
          : event.name;
      })
      .join("\n"),
    title: recording.title ?? "Recording",
  };
}

export async function readLearningSource(
  tx: ProfileReadExecutor,
  scope: DirectChatLearningScope,
  source: LearningEvidenceSelection,
  cutoff: Date,
) {
  const text =
    source.kind === "recording"
      ? await recordingEvidence(tx, scope.personId, source.id)
      : await conversationEvidence(tx, scope, source.id, cutoff);
  if (!text) return null;
  return {
    digest: createHash("sha256")
      .update(source.kind === "recording" ? JSON.stringify(text) : text.excerpt)
      .digest("hex"),
    evidence: {
      source: { kind: source.kind, id: source.id },
      ...text,
    },
  };
}

export async function setSharedLearningPermission(
  database: Database,
  personId: string,
  channelId: string,
  allowed: boolean,
) {
  return database.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          isNull(channels.deletedAt),
          sql`exists (
        select 1 from ${groupBotThreads} where ${groupBotThreads.channelId} = ${channels.id}
      )`,
        ),
      )
      .for("update");
    if (!channel) return false;
    const membership = and(
      eq(channelMemberships.channelId, channelId),
      eq(channelMemberships.userId, personId),
    );
    const [member] = await tx
      .select({ allowed: channelMemberships.learningEvidenceAllowed })
      .from(channelMemberships)
      .where(membership)
      .for("update");
    if (!member) return false;
    if (member.allowed === allowed) return true;
    await tx
      .update(channelMemberships)
      .set({ learningEvidenceAllowed: allowed })
      .where(membership);
    if (!allowed)
      await withdrawLearningEvidence(tx, personId, {
        kind: "conversation",
        id: channelId,
      });
    await tx.insert(auditEvents).values({
      actorUserId: personId,
      eventType: "learning.shared_evidence_permission_changed",
      targetType: "channel",
      targetId: channelId,
      payload: { allowed },
    });
    return true;
  });
}
