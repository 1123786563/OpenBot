import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";

/*
 * The tool/route surcharge map (Bifrost 20.1, #341): the closed enumeration of every
 * call type that can incur an extra fee, the surcharge dimension each bills on, and the
 * enablement verdict a gate reads before any tool call is dispatched.
 *
 * THE ENUMERATION IS DERIVED FROM THE HOOKS, NOT FROM TOOL NAMES. Each entry names the
 * seam that can actually execute a tool or attach a call — the resume hint's rule — and
 * the registry's test pins every anchor to real code, so a seam that moves without its
 * entry breaks the test rather than silently orphaning an entrance group 22.1 would then
 * miss (the same discipline 09.3's PERSONAL_KEY_ENTRYPOINTS registry follows). The
 * entrances at the pinned gateway:
 *
 *   - MCP tool executions: plugins/governance/main.go PreMCPHook/PostMCPHook, with
 *     mcpauthorization.go's transport approval binding one exact client+tool pair;
 *   - injected tools: core/injectedtools.go — tools Bifrost adds itself and executes
 *     when the model calls them, marked by core (isInjectedToolExecution);
 *   - Responses-declared tools: core/responsestools.go hoists a Responses request's own
 *     tool declarations before wire conversion;
 *   - A2A: plugins/governance/main.go PreA2AHook/PostA2AHook;
 *   - the routing-attached call: plugins/governance/routingembedcost.go — semantic
 *     routing's own embedding, a MODEL call that bills on the attached cell's token
 *     dimensions through the request's reservation (enumerated so 22.1 finds it
 *     accounted for, never minted a surcharge identity row);
 *   - and two non-entrances, enumerated with the reason they are none: MCP CONNECTION
 *     setup (PreMCPConnectionHook — session plumbing, not a per-call fee) and codemode
 *     meta-tools (main.go skips them at the MCP hook: not governed as tool executions).
 *
 * MISSING IS UNKNOWN, NEVER 0. The v1 wire prices exactly one tool family — server-side
 * web search (`pricing.web_search`) — plus the request-level flat fee (`pricing.request`).
 * The per-execution tool fee and the A2A call fee have no wire field at all, so their
 * dimensions are `not_on_wire_v1` and read `unknown` with `price_dim_no_source` on every
 * snapshot. That unknown is the verdict this module's assessment returns for them, and
 * it is the honest state: until the wire (or an administrator-priced override) prices
 * tool calls, an unpriced tool call is not enabled, not executed at zero cost (Q20:
 * 另外收费的供应商工具第一版默认禁用，直到能完整计费并限制成本).
 */

/** One entrance in the tool/route call registry. */
export type ToolSurchargeEntry = {
  /** The entrance's stable id in this registry — the `entry` a tool_call_charges row carries. */
  readonly id:
    | "mcp.tool_call"
    | "injected.tool_call"
    | "injected.web_search"
    | "responses.tool_call"
    | "a2a.call"
    | "routing.embed"
    | "mcp.connection"
    | "codemode.meta_tool";
  /** What this entrance is, in one line. */
  readonly surface: string;
  /**
   * The code anchor the entrance's execution lives in — a path, optionally with a symbol.
   * The registry's test checks the anchor exists; 22.1 verifies entrances against code,
   * not titles.
   */
  readonly anchor: string;
  /** The surcharge dimension a call through this entrance bills on; `null` for non-entrances. */
  readonly dimension: PriceDimension | null;
  /** True when this entrance can mint a tool-call charge identity row. */
  readonly billsIdentity: boolean;
  /**
   * Why an enumerated call type is NOT a surcharge entrance — present exactly for the
   * non-entrances, so the registry explains them instead of omitting them.
   */
  readonly notAnEntranceReason?: string;
};

/**
 * The complete registry (20.1's Produces, 22.1's input): every tool/route call type that
 * can incur an extra fee, mapped to its dimension, plus the enumerated non-entrances.
 */
export const TOOL_SURCHARGE_ENTRIES: readonly ToolSurchargeEntry[] = [
  {
    id: "mcp.tool_call",
    surface:
      "A vendor MCP tool execution through the MCP transport (governed at the hook).",
    anchor: "bifrost/plugins/governance/main.go (PreMCPHook / PostMCPHook)",
    dimension: "surcharge_tool_call",
    billsIdentity: true,
  },
  {
    id: "injected.tool_call",
    surface:
      "A provider-injected tool Bifrost itself executes when the model calls it.",
    anchor: "bifrost/core/injectedauth.go (InjectedToolAuthorized)",
    dimension: "surcharge_tool_call",
    billsIdentity: true,
  },
  {
    id: "injected.web_search",
    surface:
      "The server-side web-search tool family the wire prices per request.",
    anchor: "bifrost/core/injectedtools.go (native web search tool)",
    dimension: "surcharge_web_search",
    billsIdentity: true,
  },
  {
    id: "responses.tool_call",
    surface:
      "A tool a Responses request declares in its own input, hoisted before wire conversion.",
    anchor: "bifrost/core/responsestools.go (hoistResponsesAdditionalTools)",
    dimension: "surcharge_tool_call",
    billsIdentity: true,
  },
  {
    id: "a2a.call",
    surface: "An agent-to-agent call through the A2A transport.",
    anchor: "bifrost/plugins/governance/main.go (PreA2AHook / PostA2AHook)",
    dimension: "surcharge_a2a_call",
    billsIdentity: true,
  },
  {
    id: "routing.embed",
    surface:
      "The routing layer's attached embedding call (warmup and hot-path classification).",
    anchor: "bifrost/plugins/governance/routingembedcost.go",
    dimension: null,
    billsIdentity: false,
    notAnEntranceReason:
      "A model call the router makes: it bills on the attached model's own token dimensions through the request's reservation, never a flat surcharge.",
  },
  {
    id: "mcp.connection",
    surface: "An MCP connection setup.",
    anchor:
      "bifrost/plugins/governance/main.go (PreMCPConnectionHook / PostMCPConnectionHook)",
    dimension: null,
    billsIdentity: false,
    notAnEntranceReason:
      "Connection plumbing, not a per-call fee: no tool executes, nothing is billed per connection.",
  },
  {
    id: "codemode.meta_tool",
    surface: "A codemode meta-tool (listToolFiles, readToolFile, getToolDocs).",
    anchor:
      "bifrost/plugins/governance/main.go (IsCodemodeTool branch at PreMCPHook)",
    dimension: null,
    billsIdentity: false,
    notAnEntranceReason:
      "Codemode meta-tools are discovery, not vendor tool executions — the hook stamps their include-list and skips evaluation.",
  },
];

/** The entrance ids that mint a tool-call identity row (the closed set the table CHECKs). */
export const TOOL_IDENTITY_ENTRY_IDS = TOOL_SURCHARGE_ENTRIES.filter(
  (entry) => entry.billsIdentity,
).map((entry) => entry.id) as readonly ToolSurchargeEntryIdForIdentity[];

/** The id type a tool_call_charges row may carry. */
export type ToolSurchargeEntryIdForIdentity = Extract<
  ToolSurchargeEntry["id"],
  | "mcp.tool_call"
  | "injected.tool_call"
  | "injected.web_search"
  | "responses.tool_call"
  | "a2a.call"
>;

/**
 * The surcharge dimensions tool/route calls bill on — the set the enablement verdict
 * demands priced KNOWN before a tool call may be dispatched. `surcharge_per_request` is
 * deliberately absent: it is a request-level flat fee every billed request already
 * carries, not a tool-execution dimension.
 */
export const TOOL_SURCHARGE_BILLED_DIMENSIONS = [
  "surcharge_web_search",
  "surcharge_tool_call",
  "surcharge_a2a_call",
] as const satisfies readonly PriceDimension[];

/** Why the tool surcharge verdict refused. Closed vocabulary, displayable anywhere. */
export type ToolSurchargeEnablementIssueCode =
  /** A billed dimension is unknown on the basis — unknown is never a zero cost. */
  "tool_price_unknown";

/** One missing fact the verdict names: the dimension, and the fixed reason it is unknown. */
export type ToolSurchargeMissingDimension = {
  dimension: PriceDimension;
  reason: string;
};

/** The enablement verdict over a locked basis: priced, free, or the refusal that names why. */
export type ToolSurchargeEnablement =
  | {
      status: "enabled";
      /** True when every billed dimension is priced exactly zero — free is a price. */
      free: boolean;
    }
  | {
      status: "refused";
      code: ToolSurchargeEnablementIssueCode;
      /** Every unpriced billed dimension with its fixed reason — the re-pricing worklist. */
      missing: readonly ToolSurchargeMissingDimension[];
    };

/**
 * The enablement assessment (pure): fold a basis's dims over the billed dimension set.
 * Every billed dimension must be KNOWN — one unknown refuses the whole verdict naming
 * each missing dimension with its reason, never a 0 and never "known except". All-known
 * and all-exactly-zero is `free` (a price, executable hold-free); any known non-zero
 * amount is `enabled` and priced. This is the verdict 20.2's gate (#342) and 20.4's
 * admission door (#344) read — the single input both consume.
 */
export function assessToolSurchargeEnablement(
  dims: PriceSnapshotDims,
): ToolSurchargeEnablement {
  const missing: ToolSurchargeMissingDimension[] = [];
  for (const dimension of TOOL_SURCHARGE_BILLED_DIMENSIONS) {
    const state = dims[dimension];
    if (state.status === "unknown") {
      missing.push({ dimension, reason: state.reason });
    }
  }
  if (missing.length > 0) {
    return { status: "refused", code: "tool_price_unknown", missing };
  }
  const free = TOOL_SURCHARGE_BILLED_DIMENSIONS.every(
    (dimension) =>
      dims[dimension].status === "known" && dims[dimension].amount === "0",
  );
  return { status: "enabled", free };
}

/**
 * The registry's own consistency proof, exported for the test and any future consumer:
 * every identity entry's dimension is a surcharge member of the closed vocabulary, and
 * no dimension the registry bills is absent from it. The test pins the anchors; this
 * pins the vocabulary wiring.
 */
export function toolSurchargeRegistryIssues(): string[] {
  const issues: string[] = [];
  const vocabulary = new Set<string>(PRICE_DIMENSIONS);
  for (const entry of TOOL_SURCHARGE_ENTRIES) {
    if (entry.billsIdentity && entry.dimension === null) {
      issues.push(`${entry.id}: bills an identity row but names no dimension`);
    }
    if (entry.dimension !== null && !vocabulary.has(entry.dimension)) {
      issues.push(
        `${entry.id}: dimension ${entry.dimension} is outside PRICE_DIMENSIONS`,
      );
    }
    if (!entry.billsIdentity && entry.notAnEntranceReason === undefined) {
      issues.push(`${entry.id}: a non-entrance must say why it is none`);
    }
  }
  for (const dimension of TOOL_SURCHARGE_BILLED_DIMENSIONS) {
    if (!vocabulary.has(dimension)) {
      issues.push(`billed dimension ${dimension} is outside PRICE_DIMENSIONS`);
    }
  }
  return issues;
}
