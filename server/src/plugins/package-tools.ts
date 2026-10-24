// server/src/plugins/package-tools.ts
// PKG05（Issue #464，Spec §9）：callTool 的包分支接缝。
//
// 本模块是 plugins/ 与 enterprise/plugin-packages/dispatch.ts 之间的唯一
// 边界：类型全部自包含（scope 作为不透明值透传），store.ts 因此不需要
// 任何企业模块导入。dispatch.ts 实现这个接缝；index.ts 装配时接线。
//
// 合同要点：
//   - 每个包工具调用携带服务端签发的 run 上下文（runId/attemptGeneration/
//     scope）——它不是客户端输入，而是准入的产物；
//   - 授权判定的线性化点是 preparePackageTool → dispatchPackageTool 的
//     CAS（dispatched 后网络调用才被允许），全部拒绝返回 typed verdict，
//     不得回退 legacy grant 判定；
//   - 秘密只在 dispatch 内部使用：permit 与 ticket 均不含 token。

/** The run context the server issued at admission. `scope` is opaque here. */
export type PackageToolRunContext = {
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly scope: unknown;
};

/** One package tool the run may dispatch (the offer side). */
export type PackageToolDescriptor = {
  /** `pkg:<installId>:<resourceId>/<toolName>` — the model-facing ref. */
  readonly ref: string;
  readonly installId: string;
  readonly resourceId: string;
  readonly toolName: string;
  readonly effect: "read" | "write";
};

/** What prepare returns: the facts policy/approval need before the CAS. */
export type PackageToolTicket = {
  /** The dispatch's own identity — the CAS row it must be completed by. */
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly toolCallId: string;
  readonly ref: string;
  readonly installId: string;
  readonly resourceId: string;
  readonly toolName: string;
  readonly effect: "read" | "write";
  readonly schemaDigest: string;
  readonly connectorInstallId: string;
  readonly connectionGeneration: number;
  readonly argsDigest: string;
  readonly connectionId: string | null;
};

export type PackageToolRefusal = {
  readonly outcome: "refused";
  readonly code: string;
};

export type PackageToolPrepareResult =
  | { readonly outcome: "ticket"; readonly ticket: PackageToolTicket }
  | PackageToolRefusal;

export type PackageToolDispatchResult =
  | { readonly outcome: "ok"; readonly text: string; readonly isError: boolean }
  | PackageToolRefusal;

export type PackageToolSeam = {
  /**
   * The tools this run attempt may dispatch (pin ∩ active grant ∩ install
   * still enabled). Empty without a package run — the legacy offer is
   * unchanged.
   */
  list(input: {
    readonly context: PackageToolRunContext;
    readonly botId: string;
  }): Promise<readonly PackageToolDescriptor[]>;
  /**
   * Full revalidation + `prepared` row, before any policy/approval gate
   * opens. The ticket carries exactly what those gates need (effect, digests,
   * generations) and nothing else.
   */
  prepare(input: {
    readonly context: PackageToolRunContext;
    readonly botId: string;
    readonly actorId: string;
    readonly toolCallId: string;
    readonly ref: string;
    readonly args: Record<string, unknown>;
  }): Promise<PackageToolPrepareResult>;
  /**
   * The linearization point + transport + completion write-back, after the
   * approval gate. Revalidates everything; a changed argument set is refused
   * as a different action (A07).
   */
  dispatch(
    ticket: PackageToolTicket,
    args: Record<string, unknown>,
    input: {
      readonly context: PackageToolRunContext;
      readonly botId: string;
      readonly actorId: string;
    },
  ): Promise<PackageToolDispatchResult>;
  /** The call was refused before dispatch: prepared → cancelled. */
  cancel(
    ticket: PackageToolTicket,
    input: {
      readonly context: PackageToolRunContext;
    },
  ): Promise<void>;
};

/** The refusal the seam answers when the deployment has no dispatch wiring. */
export const PACKAGE_DISPATCH_UNWIRED = "PACKAGE_DISPATCH_UNWIRED";
