// server/src/ai-observability/integration.ts
// MOD18（Issue #638，根 #620）：M11 评测协作者的集成臂（具名收拢面）。
//
// 把供应商直调的「拨号」面与其预算/工具/准入合同收拢为一个具名事实。四个
// 成员全部是**既有实现的委托或引用**——零新逻辑、零新策略、零新 provider、
// 零新 scorer（票面验收④的本臂读法）：拨号与入场的同一事实（entranceId
// 分派、缺席回落）、评测工具的失败闭合分类、部署准入的环境解析、MOD09
// 受管预算合同的资金三门，逐项透传，本文件没有一次 `await`、没有一处判定：
//
//   dial             → createJudgeEntranceCall(entrances)（execution-boot 的
//                      既有装配：byId/byModelName 分派 + 缺席回落
//                      createGatewayModelCall()，逐字节既有实现）
//   admissionFromEnv → judgeAdmissionFromEnv（部署环境 → entrances +
//                      approvedVersions；畸形配置 stay inert）
//   classifyTool     → evaluationToolClassifier（fail-closed write，第二把
//                      钥匙拒绝一切未声明名）
//   holds            → 注入的 MOD09 ModelBudgetCreditCollaborator（结构透传，
//                      本臂不持有资金判定）
//
// 边界（MOD18-plan §1.B + 票面硬边界）：
//   - **生产装配本票不动**：拨号运行时仍走 execution-boot 的既有装配
//     （assembly/runtime.ts:7821 的消费点不变）——改拨号运行时=改评测产品
//     语义，触碰硬边界。本臂是后续票（MOD22 WORKSHOP 出口段、M07 出口段）
//     的登记接驳面：消费点迁移时 dial/holds/classifyTool 的合同已在具名处。
//   - **①受管模型门面的 Interface 复用是类型级的**：holds 以 MOD09 公开
//     合同定型，评测的预扣/结算语义仍由注入协作者承载——本臂不把运行时
//     重路由到 M06 的预算服务（那会改评测语义）。
//   - **零 SDK 面**：本文件不 import openai/AI SDK、不构造 provider 客户端、
//     不实现评分器；D6 的源级钉锁定这一点。
//   - **缺省即缺席**：未注入 credits 时 holds 成员缺席（不抛错——缺席是不
//     可用，不是错误；与 execution-boot 的 observe/callModel 缺省同纪律）。

import type { ModelBudgetCreditCollaborator } from "../enterprise/models/public";
import {
  createJudgeEntranceCall,
  evaluationToolClassifier,
  judgeAdmissionFromEnv,
} from "./execution-boot";
import type { EvaluationModelCall } from "./execution-runner";
import type { EvaluationToolClassifier } from "./executions";
import type { JudgeEntranceList } from "./scoring/judge";

/** 集成臂构造依赖：入场清单必给；资金协作者按需。 */
export interface EvaluationGovernedModelArmDeps {
  /** 部署批准的 judge 入场清单（judgeAdmissionFromEnv 的产物或等价注入）。 */
  readonly entrances: JudgeEntranceList;
  /** MOD09 受管预算合同的资金三门（真实 CreditWriter 结构可注入）。 */
  readonly credits?: ModelBudgetCreditCollaborator;
}

/** M11 评测协作者的具名集成臂：拨号 + 准入解析 + 工具分类 + 资金合同。 */
export interface EvaluationGovernedModelArm {
  /** 受管评测拨号：entranceId 分派 + 缺席回落（既有实现委托，②③不变）。 */
  readonly dial: EvaluationModelCall;
  /** 部署准入解析（env → entrances + approvedVersions；既有实现引用）。 */
  readonly admissionFromEnv: typeof judgeAdmissionFromEnv;
  /** 评测工具的失败闭合分类（既有实现引用，未声明名一律 write）。 */
  readonly classifyTool: EvaluationToolClassifier;
  /** MOD09 受管预算合同的资金三门；credits 未注入时缺席。 */
  readonly holds?: Pick<
    ModelBudgetCreditCollaborator,
    "reserveCredits" | "releaseReservation" | "markReservationUnknown"
  >;
}

/**
 * 构造集成臂。全委托：dial 交给 createJudgeEntranceCall，准入与分类是既有
 * 实现的引用，holds 是注入协作者的原样透传——本臂对评测语义零增减。
 */
export function createEvaluationGovernedModelArm(
  deps: EvaluationGovernedModelArmDeps,
): EvaluationGovernedModelArm {
  return {
    dial: createJudgeEntranceCall(deps.entrances),
    admissionFromEnv: judgeAdmissionFromEnv,
    classifyTool: evaluationToolClassifier,
    ...(deps.credits === undefined ? {} : { holds: deps.credits }),
  };
}
