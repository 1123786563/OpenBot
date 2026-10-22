# Task Brief D01：非阻断的启动诊断适配

- **Task/AC**: D01 / A09。正式 Issue：[#497](https://github.com/1123786563/OpenBot/issues/497)（本地票 `docs/tickets/upstream-openbot-update/issues/up09.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。

## 事实源

1. Spec §6 全部 4 条 + up09 六条 criteria；实施计划 I5 合约（`checkModelAvailability`/`reportIntelligenceEntitlement`，参数注入、返回分类结果、不抛到主流程）。
2. 上游参考（只读，按行为对齐）：`evidence/upstream-sources/server/src/model-availability-check.ts`（139 行）、`intelligence-entitlement-check.ts`（77 行）、上游 `server/src/index.ts` 的接线（fire-and-forget，如 `void reportIntelligenceEntitlement({...})`）。
3. 本地现状：`server/src/index.ts`（7147 行）无对应诊断；本地模型访问是 Bifrost/网关体系（ADR 0002/0003），Learning/Intelligence 是可选依赖。**配置沿用本地 model-access/Bifrost 与 Learning 启用的真实条件**——上游的 lookup 来源（官方 metadata/网关 metadata）须映射到本地已有网关 metadata 能力；**本地网关无合法元数据探测接口则 skipped，不从任意 URL 推断、不旁路虚拟 Key、不产生推理计费调用**。

## I5 合约（严格遵守）

```ts
type StartupCheckResult = {
  kind: 'available' | 'skipped' | 'warning';
  code?: 'unconfigured' | 'unsupported' | 'credential-rejected'
    | 'model-unavailable' | 'entitlement-unavailable' | 'timeout' | 'unreadable';
  message?: string;
};
checkModelAvailability(options: {
  enabled: boolean; model: string;
  lookup?: (signal: AbortSignal) => Promise<{status: number}>;
  log: (result: StartupCheckResult) => void;
}): Promise<StartupCheckResult>;
reportIntelligenceEntitlement(options: {
  enabled: boolean;
  read?: (signal: AbortSignal) => Promise<{active: boolean}>;
  log: (result: StartupCheckResult) => void;
}): Promise<StartupCheckResult>;
```

统一单次探测预算 3,000ms；AbortSignal 取消支持的网络请求；只用 Promise.race 超时但让请求永久悬挂**不算**完成；只报告一次分类结果；失败不阻断启动。

## owned_files

- `server/src/model-availability-check.ts`、`server/src/intelligence-entitlement-check.ts`（新建）+ 同名 tests（新建）
- `server/src/index.ts`（仅诊断装配的最小接线）

## 要求（RED→GREEN→REFACTOR）

1. **RED**：新 tests 注入 fake fetch/logger——缺 key→skipped/unconfigured；无 Intelligence/learning 关闭→skipped；供应商 401/403→credential-rejected；官方 model API 404→model-unavailable；兼容 endpoint 无 lookup→skipped；超时（>3000ms，fake 时钟）→timeout 且请求被 abort；不可读响应→unreadable；每次启动只 log 一次；日志不含 key/认证 header/含凭据 URL。
2. **GREEN**：实现 I5；`server/src/index.ts` 以 fire-and-forget 装配（不 await、不抛、错误只记录一次），服务器仍正常启动（用现有启动装配测试或最小装配用例证明非阻断——不可伪造"启动成功"）。
3. **边界**：entitlement 只诊断**实际启用**的可选学习依赖；未启用 Intelligence 的部署契约不变（诊断根本不探测）；Hindsight/普通聊天依赖边界不变；不新建 readiness 权威。
4. **验证**：两个新 suite 按实际 import 归层执行（e2e-compat→`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts <file>`；bun→driven）并登记对账；`bun run --filter server typecheck`（bootstrap BASE 红不计入）；`bunx biome format` 每改动文件真实 exit 0（新增行）。

## 禁止

- 不旁路虚拟 Key、不创建推理 token 调用、不扩大供应商权限；不记录秘密；不改配置/业务请求路径；诊断不当授权事实源。

## 报告

`evidence/d01/implementer-report.md`：改动摘要、I5 对照、分类矩阵（fake 证据）、装配接线说明与非阻断证明、归层对账、format/typecheck、偏差。
