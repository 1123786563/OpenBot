import type {
  CheckpointDTO,
  ConversationDTO,
  EventDTO,
  PublicRunInput,
  RunDTO,
  RunStatus,
  RuntimeInvocation,
  ToolReceiptDTO,
} from "../../../shared/enterprise/contracts";

export {
  CheckpointDTOZ,
  CheckpointProposalWireSchema,
  ConversationDTOZ,
  EventDTOZ,
  PublicRunInputSchema,
  PublicRuntimeInvocationSchema,
  RunDTOZ,
  RunEventProposalWireSchema,
  RuntimeInvocationWireSchema,
  ToolExecutionWireSchema,
  ToolPreparationWireSchema,
  ToolReceiptDTOZ,
  WireSchemaV1,
} from "./wire-schema";
export type {
  CheckpointDTO,
  ConversationDTO,
  EventDTO,
  PublicRunInput,
  RunDTO,
  RunStatus,
  RuntimeInvocation,
  ToolReceiptDTO,
};

export interface PlatformScope {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly memberEpoch: number;
  readonly aclEpoch: number;
  readonly entrypoint: "web" | "desktop" | "mobile" | "schedule";
}

export interface ResourceView {
  readonly resourceId: string;
  readonly resourceType: string;
  readonly revision: number;
  readonly displayName: string;
}

export interface ScopeResolver {
  resolve(request: Request): Promise<PlatformScope>;
}

export interface ResourceReader {
  readAuthorizedResource(
    scope: PlatformScope,
    resourceId: string,
  ): Promise<ResourceView>;
}

export interface ConversationService {
  getOrCreate(
    scope: PlatformScope,
    input: ConversationInput,
  ): Promise<ConversationDTO>;
  append(scope: PlatformScope, input: AppendMessageInput): Promise<MessageDTO>;
  history(scope: PlatformScope, input: HistoryInput): Promise<MessagePage>;
  resolveBackend(
    scope: PlatformScope,
    threadId: string,
  ): Promise<StorageBackend>;
}

export interface RunService {
  start(scope: PlatformScope, input: StartRunInput): Promise<RunDTO>;
  cancel(scope: PlatformScope, input: CancelRunInput): Promise<RunDTO>;
  get(scope: PlatformScope, runId: string): Promise<RunDTO>;
  reserveModelBudget(
    scope: PlatformScope,
    input: BudgetInput,
  ): Promise<BudgetReservation>;
}

export interface EventService {
  append(scope: PlatformScope, event: EventProposal): Promise<EventAck>;
  replay(scope: PlatformScope, input: EventCursor): Promise<EventPage>;
  subscribe(
    scope: PlatformScope,
    input: EventCursor,
    signal: AbortSignal,
  ): AsyncIterable<EventDTO>;
}

export interface EventProposal {
  readonly runId: string;
  readonly attemptId: string;
  readonly sourceEventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly payload: EventDTO["payload"];
}

export interface CheckpointService {
  read(scope: PlatformScope, runId: string): Promise<CheckpointDTO | null>;
  propose(
    scope: PlatformScope,
    input: CheckpointProposal,
  ): Promise<CheckpointAck>;
}

export interface RecoveryService {
  resume(scope: PlatformScope, input: ResumeInput): Promise<RunDTO>;
}

export interface ToolService {
  prepare(scope: PlatformScope, input: ToolPreparation): Promise<PreparedTool>;
  execute(scope: PlatformScope, input: ToolExecution): Promise<ToolReceiptDTO>;
  resolveApproval(
    scope: PlatformScope,
    input: ApprovalResolution,
  ): Promise<ApprovalDTO>;
}

export type StorageBackend = "intelligence" | "platform";

export interface ConversationInput {
  readonly threadId?: string;
  readonly title?: string;
}
export interface AppendMessageInput {
  readonly threadId: string;
  readonly clientMessageKey: string;
  readonly content: string;
  readonly attachments: readonly string[];
}
export interface HistoryInput {
  readonly threadId: string;
  readonly beforeSeq: number | null;
  readonly limit: number;
}
export interface MessageDTO {
  readonly messageId: string;
  readonly threadId: string;
  readonly seq: number;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly attachments: readonly string[];
  readonly createdAt: string;
}
export interface MessagePage {
  readonly items: readonly MessageDTO[];
  readonly nextBeforeSeq: number | null;
}

export interface StartRunInput {
  readonly threadId: string;
  readonly clientMessageKey: string;
  readonly attachmentRefs: readonly string[];
  readonly entrypoint: PlatformScope["entrypoint"];
}
export interface CancelRunInput {
  readonly runId: string;
  readonly reason: "user_requested" | "timeout" | "superseded";
}
export interface BudgetInput {
  readonly runId: string;
  readonly modelRouteRef: string;
  readonly maximumTokens: number;
}
export interface BudgetReservation {
  readonly reservationId: string;
  readonly runId: string;
  readonly tokenLimit: number;
  readonly expiresAt: string;
}

export interface ToolPreparation {
  readonly runId: string;
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly stepId: string;
  readonly installationVersion: string;
  readonly target: { readonly kind: string; readonly id: string };
  readonly args: Readonly<Record<string, JsonValue>>;
  readonly argsDigest: string;
  readonly fencingToken: string;
}
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export interface ToolExecution {
  readonly operationId: string;
  readonly attemptId: string;
  readonly argsDigest: string;
  readonly approvalRef?: string;
  readonly fencingToken: string;
}
export interface PreparedTool {
  readonly operationId: string;
  readonly status: "prepared" | "waiting_approval" | "rejected";
  readonly approvalRequired: boolean;
  readonly argsDigest: string;
}
export interface ApprovalResolution {
  readonly approvalId: string;
  readonly decision: "approved" | "denied" | "cancelled";
}
export interface ApprovalDTO {
  readonly approvalId: string;
  readonly status: "pending" | "approved" | "denied" | "cancelled";
  readonly decidedAt?: string;
}

export interface EventAck {
  readonly eventId: string;
  readonly seq: number;
  readonly duplicate: boolean;
}
export interface EventCursor {
  readonly afterSeq: number;
  readonly limit?: number;
}
export interface EventPage {
  readonly items: readonly EventDTO[];
  readonly nextCursor: EventCursor | null;
}

export interface CheckpointProposal {
  readonly schemaVersion: 1;
  readonly expertVersion: string;
  readonly runtimeCompatibility: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly messageRefs: readonly string[];
  readonly completedOperationRefs: readonly string[];
  readonly pendingApprovalRef: string | null;
  readonly budgetReservationId: string;
  readonly artifactRefs: readonly string[];
  readonly contentDigest: string;
}
export interface CheckpointAck {
  readonly checkpointId: string;
  readonly accepted: boolean;
}
export interface ResumeInput {
  readonly runId: string;
  readonly checkpointId: string;
  readonly idempotencyKey: string;
}

export interface PlatformRunnerDeps {
  readonly runService: RunService;
  readonly eventService: EventService;
  readonly toolService: ToolService;
  readonly resourceReader: ResourceReader;
  readonly loadAuthorizedAgent: (
    scope: PlatformScope,
    agentId: string,
  ) => Promise<unknown>;
}
export interface PlatformCopilotDeps {
  readonly runner: PlatformRunnerDeps;
  readonly scopeResolver: ScopeResolver;
  readonly conversationService: ConversationService;
}
export interface PlatformRuntimeDeps {
  readonly copilot: PlatformCopilotDeps;
  readonly checkpointService: CheckpointService;
  readonly recoveryService: RecoveryService;
}
export interface PlatformRuntime {
  readonly handleCopilot: (request: Request) => Promise<Response>;
  readonly handleInternal: (request: Request) => Promise<Response>;
}
export interface HeadlessTurnInput {
  readonly threadId: string;
  readonly inputText: string;
  readonly idempotencyKey: string;
}
export interface HeadlessTurnResult {
  readonly run: RunDTO;
  readonly events: readonly EventDTO[];
}

export interface MemorySourceReference {
  readonly sourceType: "message" | "attachment" | "tool_result";
  readonly sourceId: string;
  readonly digest: string;
}
export interface DeletionReceipt {
  readonly sourceId: string;
  readonly deletedAt: string;
  readonly deletionId: string;
}
export interface LearningJobDTO {
  readonly jobId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly createdAt: string;
}
export interface SkillCandidateDTO {
  readonly candidateId: string;
  readonly status: "pending_review" | "approved" | "rejected" | "published";
  readonly createdAt: string;
}
export interface CandidateReviewInput {
  readonly candidateId: string;
  readonly decision: "approve" | "reject";
  readonly idempotencyKey: string;
}
export interface SkillVersionDTO {
  readonly skillId: string;
  readonly version: number;
  readonly status: "draft" | "published" | "retired";
}
export interface SkillSelection {
  readonly skillId: string;
  readonly version?: number;
}
export interface SkillSnapshot {
  readonly snapshotId: string;
  readonly selections: readonly SkillSelection[];
  readonly contentDigest: string;
}

export interface LegacyArchive {
  readonly source: "intelligence";
  readonly sourceDigest: string;
  readonly conversations: readonly {
    readonly legacyId: string;
    readonly threadId: string;
    readonly messages: readonly MessageDTO[];
  }[];
}
export interface ImportOptions {
  readonly dryRun: boolean;
  readonly conflictPolicy: "fail" | "preserve_platform" | "preserve_legacy";
}
export interface ImportReport {
  readonly imported: number;
  readonly skipped: number;
  readonly sourceDigest: string;
  readonly mappings?: Readonly<Record<string, string>>;
  readonly failures: readonly {
    readonly legacyId: string;
    readonly reason: string;
  }[];
}
export interface CutoverInput {
  readonly conversationId: string;
  readonly expectedBackend: StorageBackend;
  readonly idempotencyKey: string;
}
export interface CutoverReceipt {
  readonly conversationId: string;
  readonly storageBackend: "platform";
  readonly cutoverId: string;
  readonly completedAt: string;
}

export interface ModelGateway {
  handle(request: Request): Promise<Response>;
}

/** Complete compile-time registry consumed by downstream migration tasks. */
export interface EnterpriseContractRegistry {
  PlatformScope: PlatformScope;
  ScopeResolver: ScopeResolver;
  ResourceReader: ResourceReader;
  StorageBackend: StorageBackend;
  ConversationService: ConversationService;
  RunService: RunService;
  EventService: EventService;
  CheckpointService: CheckpointService;
  RecoveryService: RecoveryService;
  ToolService: ToolService;
  ConversationInput: ConversationInput;
  AppendMessageInput: AppendMessageInput;
  HistoryInput: HistoryInput;
  MessagePage: MessagePage;
  MessageDTO: MessageDTO;
  StartRunInput: StartRunInput;
  CancelRunInput: CancelRunInput;
  BudgetInput: BudgetInput;
  BudgetReservation: BudgetReservation;
  RunStatus: RunStatus;
  ToolPreparation: ToolPreparation;
  ToolExecution: ToolExecution;
  PreparedTool: PreparedTool;
  ToolReceiptDTO: ToolReceiptDTO;
  ApprovalResolution: ApprovalResolution;
  ApprovalDTO: ApprovalDTO;
  EventProposal: EventProposal;
  EventAck: EventAck;
  EventCursor: EventCursor;
  EventPage: EventPage;
  EventDTO: EventDTO;
  CheckpointProposal: CheckpointProposal;
  CheckpointAck: CheckpointAck;
  CheckpointDTO: CheckpointDTO;
  ResumeInput: ResumeInput;
  PlatformRunnerDeps: PlatformRunnerDeps;
  PlatformCopilotDeps: PlatformCopilotDeps;
  PlatformRuntimeDeps: PlatformRuntimeDeps;
  PlatformRuntime: PlatformRuntime;
  HeadlessTurnInput: HeadlessTurnInput;
  HeadlessTurnResult: HeadlessTurnResult;
  MemorySourceReference: MemorySourceReference;
  DeletionReceipt: DeletionReceipt;
  LearningJobDTO: LearningJobDTO;
  SkillCandidateDTO: SkillCandidateDTO;
  CandidateReviewInput: CandidateReviewInput;
  SkillVersionDTO: SkillVersionDTO;
  SkillSelection: SkillSelection;
  SkillSnapshot: SkillSnapshot;
  LegacyArchive: LegacyArchive;
  ImportOptions: ImportOptions;
  ImportReport: ImportReport;
  CutoverInput: CutoverInput;
  CutoverReceipt: CutoverReceipt;
  ModelGateway: ModelGateway;
  RuntimeInvocation: RuntimeInvocation;
}
