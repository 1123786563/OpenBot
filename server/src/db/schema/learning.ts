import type {
  DirectChatReview,
  directChatLearning,
  directChatProposal,
  LearningEvidenceSelection,
} from "@openbot/shared/direct-chat-learning";
import type {
  LearningSettings,
  LearningSharingMode,
} from "@openbot/shared/learning";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { z } from "zod";
import { intelligenceChannelMappings, users } from "./core";
import { jsonb } from "./json";

export const learningSettings = pgTable("learning_settings", {
  id: text("id").primaryKey(),
  settings: jsonb("settings").$type<LearningSettings>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A Thread cannot move containers. Null records an explicit unassigned first run. */
export const learningThreadBindings = pgTable(
  "learning_thread_bindings",
  {
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    containerId: text("container_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId] })],
);

/**
 * A person's own Learning space: the Intelligence Learning container every recording they make joins
 * (learning/personal-space.ts). A row means OpenBot saw the container exist, because it created it, Intelligence said
 * the id was already taken, or the runtime key read it. The id is derived from the person's, so the row only remembers
 * that it exists. It goes with its person; the container stays in Intelligence.
 */
export const learningPersonSpaces = pgTable("learning_person_spaces", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  containerId: text("container_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Who else's Bots use the Skills learned in a person's own space: `closed` (only their own Bots, and the meaning of no
 * row), `open` (every Bot in the deployment) or `choose` (every Bot, for the Skills listed in learning_open_skills).
 */
export const learningSkillSharing = pgTable(
  "learning_skill_sharing",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").$type<LearningSharingMode>().notNull().default("closed"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "learning_skill_sharing_mode_check",
      sql`${table.mode} IN ('closed', 'open', 'choose')`,
    ),
    // Delivery reads only the people who opened something.
    index("learning_skill_sharing_open_idx")
      .on(table.userId)
      .where(sql`${table.mode} <> 'closed'`),
  ],
);

/**
 * The Skills a person in `choose` opened to every Bot, by name. Kept when they switch to another mode, so switching back
 * opens the same ones again.
 */
export const learningOpenSkills = pgTable(
  "learning_open_skills",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.skillName] })],
);

/**
 * One row per person and Skill they or an admin approved in the person's space. No row means it was approved before OpenBot recorded approvals (or in the Intelligence dashboard), and is treated as admin-approved.
 * `sharing` follows the request to open the Skill to every Bot.
 */
export const learningSkillApprovals = pgTable(
  "learning_skill_approvals",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    approvedBy: text("approved_by").$type<"person" | "admin">().notNull(),
    sharing: text("sharing")
      .$type<"none" | "requested" | "approved" | "declined">()
      .notNull()
      .default("none"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.skillName] }),
    check(
      "learning_skill_approvals_approved_by_check",
      sql`${table.approvedBy} IN ('person', 'admin')`,
    ),
    check(
      "learning_skill_approvals_sharing_check",
      sql`${table.sharing} IN ('none', 'requested', 'approved', 'declined')`,
    ),
  ],
);

type DirectChatAnalysisState = NonNullable<
  z.infer<typeof directChatLearning>["latest"]
>["state"];

export const directChatAnalyses = pgTable(
  "direct_chat_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: text("thread_id")
      .notNull()
      .references(() => intelligenceChannelMappings.threadId, {
        onDelete: "cascade",
      }),
    botId: text("bot_id").notNull(),
    state: text("state").$type<DirectChatAnalysisState>().notNull(),
    reason: text("reason"),
    evidenceSources: jsonb("evidence_sources")
      .$type<
        (LearningEvidenceSelection & { digest: string; cutoff: string })[]
      >()
      .notNull()
      .default([]),
    revisesProposalId: uuid("revises_proposal_id"),
    evidenceRunIds: jsonb("evidence_run_ids").$type<string[]>().notNull(),
    proposal: jsonb("proposal").$type<z.infer<typeof directChatProposal>>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("direct_chat_analyses_history_idx").on(
      table.threadId,
      table.startedAt,
      table.id,
    ),
    uniqueIndex("direct_chat_analyses_active_idx")
      .on(table.threadId)
      .where(sql`${table.state} in ('running', 'reconciling')`),
    check(
      "direct_chat_analyses_state_check",
      sql`${table.state} in ('running', 'reconciling', 'proposed', 'skipped', 'failed', 'cancelled')`,
    ),
    check(
      "direct_chat_analyses_proposal_check",
      sql`(${table.state} = 'proposed') = (${table.proposal} is not null)`,
    ),
  ],
);

export const directChatLearningSchedules = pgTable(
  "direct_chat_learning_schedules",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => intelligenceChannelMappings.threadId, {
        onDelete: "cascade",
      }),
    botId: text("bot_id").notNull(),
    enabled: boolean("enabled").notNull(),
    intervalHours: integer("interval_hours").notNull(),
    nextAt: timestamp("next_at", { withTimezone: true }),
    evidenceAfter: timestamp("evidence_after", { withTimezone: true }),
    lastAnalysisId: uuid("last_analysis_id").references(
      () => directChatAnalyses.id,
      {
        onDelete: "set null",
      },
    ),
    ownsLastAnalysis: boolean("owns_last_analysis").notNull().default(false),
    pendingDispatch: boolean("pending_dispatch").notNull().default(false),
  },
  (table) => [
    index("direct_chat_learning_schedules_due_idx")
      .on(table.nextAt)
      .where(sql`${table.enabled}`),
    check(
      "direct_chat_learning_schedules_interval_check",
      sql`${table.intervalHours} between 1 and 168`,
    ),
  ],
);

// The decision and its complete delivery scope are recorded together. Approval publishes it.
export const directChatProposalReviews = pgTable(
  "direct_chat_proposal_reviews",
  {
    proposalId: uuid("proposal_id")
      .primaryKey()
      .references(() => directChatAnalyses.id, { onDelete: "cascade" }),
    review: jsonb("review").$type<DirectChatReview>().notNull(),
  },
);

export const personalLearningAutoApproval = pgTable(
  "personal_learning_auto_approval",
  {
    personId: text("person_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
  },
);
