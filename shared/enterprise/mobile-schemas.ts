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

/** 客户端向会话提交一条消息 */
export const SubmitMessageSchema = z
  .object({
    threadId: z.string().min(1),
    content: z.string().min(1),
  })
  .strict();

export type SubmitMessage = z.infer<typeof SubmitMessageSchema>;

/** 已受理的提交（服务端视角的排队结果） */
export const SubmissionSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    status: z.string().min(1),
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
