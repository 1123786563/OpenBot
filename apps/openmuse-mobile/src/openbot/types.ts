import { z } from "zod";

/**
 * OpenBot 接口的数据模型，字段名与服务端（server/src/mobile-bff、
 * channels、delivery）逐一对照，非顶层复用上游 OpenBotAdapter——那套
 * schema 面向 computer 控制，这里补充移动端首屏与消息闭环所需。
 */

const nonempty = z.string().min(1);

/** GET /api/me 响应（服务端 app.ts /api/me：{ user: {...actor, onboarding} }）。 */
export const meSchema = z.object({
  user: z.object({
    id: nonempty,
    role: z.enum(["user", "admin", "bot", "service"]).or(z.string()),
    name: z.string().optional(),
    email: z.string().optional(),
    onboarding: z
      .object({ status: z.enum(["in_progress", "completed"]).optional() })
      .nullable()
      .optional(),
  }),
});
export type OpenBotMe = z.infer<typeof meSchema>;

/** POST /api/mobile/conversations 的 201 响应（设计文档 §6.1 OpenBotSession）。 */
export const openBotSessionSchema = z.object({
  channelId: nonempty,
  botId: nonempty,
  threadId: nonempty,
  mode: z.literal("single"),
});
export type OpenBotSession = z.infer<typeof openBotSessionSchema>;

/** GET /api/mobile/workspace 的冷启动聚合（BFF workspace.ts 的形状）。 */
export const workspaceSchema = z.object({
  user: z.object({ id: nonempty, role: z.string() }),
  agents: z.array(
    z.object({
      id: nonempty,
      name: z.string(),
      title: z.string(),
      avatarSeed: z.string(),
      visibility: z.enum(["public", "private"]),
    }),
  ),
  channels: z.array(
    z.object({
      id: nonempty,
      name: z.string(),
      agentIds: z.array(nonempty),
      threadId: nonempty,
      lastMessageAt: z.string().nullable(),
    }),
  ),
});
export type OpenBotWorkspace = z.infer<typeof workspaceSchema>;

/** GET /api/delivery/conversations 分页列表。 */
export const conversationsSchema = z.object({
  conversations: z.array(
    z.object({
      id: nonempty,
      name: z.string(),
      agentIds: z.array(nonempty),
      threadId: nonempty.optional(),
      lastMessageAt: z.union([z.string(), z.null()]).optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type OpenBotConversations = z.infer<typeof conversationsSchema>;

/**
 * GET /api/delivery/conversations/:id/history?agentId= 的消息体。
 * Intelligence 线程消息的 content 形态宽松（文本或分段数组），这里只
 * 校验骨架，内容渲染交给现有 AssistantResponse。
 */
export const historySchema = z.object({
  history: z.array(
    z.object({
      id: z.string().optional(),
      role: z.string(),
      content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
      createdAt: z.string().optional(),
    }),
  ),
});
export type OpenBotHistory = z.infer<typeof historySchema>;

/**
 * POST /api/delivery/conversations/:id/messages 的 202 响应：
 * 服务端只承诺"已受理"，结果经 Intelligence 异步产生，由 history 轮询或
 * CopilotKit Runtime 事件读取（设计文档 §7.1）。
 */
export const messageAcceptedSchema = z.object({
  messageId: z.string().optional(),
  threadId: z.string().optional(),
  status: z.string().optional(),
});
export type OpenBotMessageAccepted = z.infer<typeof messageAcceptedSchema>;

/** GET /api/mobile/activity 的活动聚合（可选装配）。 */
export const activitySchema = z.object({
  approvals: z
    .object({ requests: z.array(z.unknown()).optional() })
    .nullable()
    .optional(),
  routines: z.array(z.unknown()).optional(),
});
export type OpenBotActivity = z.infer<typeof activitySchema>;
