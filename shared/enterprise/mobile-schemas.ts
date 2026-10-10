import { z } from "zod";

export const TenantRoleSchema = z.enum(["tenant_admin", "member", "auditor"]);
export type TenantRole = z.infer<typeof TenantRoleSchema>;

export const TenantSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: TenantRoleSchema,
  })
  .strict();

export type TenantSummary = z.infer<typeof TenantSummarySchema>;

/** 02 册 §4.3 对外错误合同：code/request_id/retryable/summary，不含内部细节 */
export const EnterpriseApiErrorSchema = z
  .object({
    code: z.string().min(1),
    request_id: z.string().min(1),
    retryable: z.boolean(),
    summary: z.string().min(1),
  })
  .strict();

export type EnterpriseApiError = z.infer<typeof EnterpriseApiErrorSchema>;

/** 个人会话视图：认证用户与其可选租户列表，禁止携带 scope/凭证类字段（与 TenantSummary 同一理由） */
export const PersonalSessionSchema = z
  .object({
    userId: z.string().min(1),
    tenants: z.array(TenantSummarySchema),
  })
  .strict();

export type PersonalSession = z.infer<typeof PersonalSessionSchema>;

/** 字符串游标分页信封；nextCursor 为 null 表示没有下一页 */
export function StringCursorPageSchema<T>(item: z.ZodType<T>) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().min(1).nullable(),
    })
    .strict();
}

/** 对移动端公开的运行事件（run 事件正文语义由 03 册定义，这里只约束信封） */
export const PublicRunEventSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    kind: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

export type PublicRunEvent = z.infer<typeof PublicRunEventSchema>;

/**
 * 客户端向会话提交一条消息（conversations-subsystem §3.2 冻结给 C07）：
 * threadId/channelId 走请求路径不入 body，幂等键 clientMessageId 必填，
 * .strict() 让 principalId/tenantId/token 等身份与凭证字段天然被拒。
 */
export const SubmitMessageSchema = z
  .object({
    clientMessageId: z.string().min(1).max(128),
    text: z.string().min(1).max(16000),
    attachmentIds: z.array(z.string().min(1)).max(8),
  })
  .strict();

export type SubmitMessage = z.infer<typeof SubmitMessageSchema>;

/** 已受理的提交（202 语义：accepted 为字面 true，受理 ≠ 执行完成） */
export const SubmissionSchema = z
  .object({
    messageId: z.string().min(1),
    runId: z.string().min(1),
    accepted: z.literal(true),
  })
  .strict();

export type Submission = z.infer<typeof SubmissionSchema>;

/** 幂等操作回执：02 册 operationId 语义（同 operationId 重放返回原结果） */
export const OperationReceiptSchema = z
  .object({
    operationId: z.string().min(1),
    status: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;

/*
 * 企业 Bot/Channel/Thread 会话子系统的两个冻结 DTO（C05），依据
 * docs/superpowers/specs/enterprise-conversations-subsystem.md §3.2。
 * 与登录会话视图 PersonalSession 不同名不同义：PersonalConversation 是个人
 * Channel 会话（服务端权威；threadId 由服务端生成，客户端不提交任何身份字段，
 * .strict() 让 principalId/scope/token 等身份与凭证字段天然被拒）。
 */
export const PersonalConversationSchema = z
  .object({
    channelId: z.string().min(1),
    botId: z.string().min(1),
    threadId: z.string().min(1),
    mode: z.literal("single"),
    status: z.enum(["active", "archived"]),
  })
  .strict();

export type PersonalConversation = z.infer<typeof PersonalConversationSchema>;

/** Channel 创建请求（幂等键由客户端提供，身份由 Scope 决定） */
export const CreateChannelSchema = z
  .object({
    botId: z.string().min(1),
    clientRequestId: z.string().min(1).max(128),
  })
  .strict();

export type CreateChannel = z.infer<typeof CreateChannelSchema>;
