import { z } from "zod";
import { openbotFetch } from "./client";
import { OpenBotError } from "./errors";
import type {
  OpenBotActivity,
  OpenBotConversations,
  OpenBotHistory,
  OpenBotMe,
  OpenBotMessageAccepted,
  OpenBotSession,
  OpenBotWorkspace,
} from "./types";
import {
  activitySchema,
  conversationsSchema,
  historySchema,
  meSchema,
  messageAcceptedSchema,
  openBotSessionSchema,
  workspaceSchema,
} from "./types";

/**
 * OpenBot 高层 API：面向移动端场景组合 transport 与数据模型。
 * 一处一个端点，语义与设计文档 §6.2 获取会话、§7.2 阶段 A 消息闭环对齐。
 */

/** 登录后自检：确认会话有效并取回用户。401 会抛 authentication_required。 */
export function fetchMe(signal?: AbortSignal): Promise<OpenBotMe> {
  return openbotFetch("/api/me", meSchema, { signal });
}

/** 冷启动聚合：用户 + Bot 名册 + 既有会话（一次往返）。 */
export function fetchWorkspace(signal?: AbortSignal): Promise<OpenBotWorkspace> {
  return openbotFetch("/api/mobile/workspace", workspaceSchema, { signal });
}

/**
 * 打开/恢复与某个 Bot 的会话，返回 OpenBotSession 三标识。
 * 幂等语义由服务端 direct() 提供：重复调用回到同一 channel。
 */
export function openConversation(
  botId: string,
  signal?: AbortSignal,
): Promise<OpenBotSession> {
  const id = botId.trim();
  if (!id) throw new OpenBotError("invalid_input", "缺少 Bot ID。");
  return openbotFetch(
    "/api/mobile/conversations",
    openBotSessionSchema,
    { method: "POST", body: { botId: id }, signal },
    true,
  );
}

/** 会话分页列表（Delivery 视角）。cursor 缺省取第一页。 */
export function fetchConversations(
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<OpenBotConversations> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return openbotFetch(
    `/api/delivery/conversations${query}`,
    conversationsSchema,
    { signal },
  );
}

/** 某个会话的历史消息（Design §7.2 阶段 A 的读路径）。 */
export function fetchHistory(
  channelId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<OpenBotHistory> {
  return openbotFetch(
    `/api/delivery/conversations/${encodeURIComponent(channelId)}/history` +
      `?agentId=${encodeURIComponent(agentId)}`,
    historySchema,
    { signal },
  );
}

/**
 * 发送消息（阶段 A 写路径）。202 只代表受理；回复经 Intelligence 生成，
 * 由 fetchHistory 轮询或 Runtime 事件读取。externalId 是客户端幂等键，
 * 同一 UUID 重发不会产生重复消息。
 */
export function sendMessage(
  channelId: string,
  agentId: string,
  text: string,
  externalId: string,
  signal?: AbortSignal,
): Promise<OpenBotMessageAccepted> {
  return openbotFetch(
    `/api/delivery/conversations/${encodeURIComponent(channelId)}/messages`,
    messageAcceptedSchema,
    { method: "POST", body: { agentId, text, externalId }, signal },
    true,
  );
}

/** 活动聚合（审批 + 例程计数），部署未装配 activity 时为 404，调用方按空处理。 */
export async function fetchActivity(
  signal?: AbortSignal,
): Promise<OpenBotActivity | null> {
  try {
    return await openbotFetch("/api/mobile/activity", activitySchema, { signal });
  } catch (error) {
    if (error instanceof OpenBotError && error.status === 404) return null;
    throw error;
  }
}

/** 空对象 schema（probe 兼容用）。 */
export const unitSchema = z.object({}).passthrough();
