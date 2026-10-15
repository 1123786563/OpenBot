export const SDK_COMPATIBILITY = {
  copilotkit: {
    package: "@copilotkit/runtime",
    version: "1.77.0",
    integrity:
      "sha512-dhzVC+rRcjRWHaMwWlspIlfNX8gNBaDBLsevWkOuDYL880WGa1pSaOB8bC+vx8c1tVceY8iUOrlRXOGBDkIWNA==",
    package_json_sha256:
      "8d25d21f2824eba2f9450408c772beabcbe9f8029e2a97aa57cd20688c51629f",
  },
  copilotkit_core: {
    package: "@copilotkit/core",
    version: "1.77.0",
    integrity:
      "sha512-p+GHbrVPgPLNgGVMAj5IfDIkzjzX0YemASXDbX8bWj+3+XFQuiqCpxu0kq6Zh0U/Tb7Be+0Kps130aw48ks2Ig==",
    package_json_sha256:
      "5bacb770153cd75f1f002fe7725719dfe855d5a268f5cef72327212880ae01cb",
  },
  ag_ui: {
    package: "@ag-ui/core",
    version: "1.0.1",
    protocol_version: "1.0",
    integrity:
      "sha512-Q6pxgI7gcey/0pHfM37S7GNrsYqTrrjjFLpi1dckHNGX2l9VTL0CjnyNc44lwPfHIzFmmEvQfbrAeEPINGGg/Q==",
    package_json_sha256:
      "79afb0b9e4a2ed14ba4c03548d108663bcf7c27577a4f1a66f75b5e97ec40b1a",
  },
  ag_ui_client: {
    package: "@ag-ui/client",
    version: "1.0.1",
    integrity:
      "sha512-AxJ1+fnsRrhWBg+dXItoyXNqUhI/tOXk0/TxXrsuvdjtyTx216Hu+3q5DgQnTDbluP95fCW4buoCKQsKpHmmCw==",
    package_json_sha256:
      "c8b0a01e83dff8ad8b151d8a1147e759a75422c0f317b3bc0d0ea298910dbe3e",
  },
  platform_contract_version: 1,
  routes: [
    { operation: "info", method: "GET", path: "/api/copilotkit/info" },
    {
      operation: "run",
      method: "POST",
      path: "/api/copilotkit/agent/:agent_id/run",
    },
    {
      operation: "connect",
      method: "POST",
      path: "/api/copilotkit/agent/:agent_id/connect",
    },
    {
      operation: "stop",
      method: "POST",
      path: "/api/copilotkit/agent/:agent_id/stop/:thread_id",
    },
    {
      operation: "threads_list",
      method: "GET",
      path: "/api/copilotkit/threads",
    },
  ] as const,
  platform_routes: [
    {
      operation: "threads_create",
      method: "POST",
      path: "/api/enterprise/v1/conversations",
    },
    {
      operation: "threads_delete",
      method: "DELETE",
      path: "/api/enterprise/v1/conversations/:id",
    },
  ],
} as const;

type CompatibilityResult = { valid: true } | { valid: false; issues: string[] };

export function verifySdkCompatibilityFixture(
  value: unknown,
): CompatibilityResult {
  if (
    !isRecord(value) ||
    value.fixture_version !== 1 ||
    !isRecord(value.source)
  ) {
    return { valid: false, issues: ["fixture header is malformed"] };
  }
  if (
    value.source.copilotkit_version !== SDK_COMPATIBILITY.copilotkit.version ||
    value.source.copilotkit_integrity !==
      SDK_COMPATIBILITY.copilotkit.integrity ||
    value.source.copilotkit_core_version !==
      SDK_COMPATIBILITY.copilotkit_core.version ||
    value.source.copilotkit_core_integrity !==
      SDK_COMPATIBILITY.copilotkit_core.integrity ||
    value.source.copilotkit_core_package_json_sha256 !==
      SDK_COMPATIBILITY.copilotkit_core.package_json_sha256 ||
    value.source.ag_ui_version !== SDK_COMPATIBILITY.ag_ui.version ||
    value.source.ag_ui_protocol_version !==
      SDK_COMPATIBILITY.ag_ui.protocol_version ||
    value.source.ag_ui_integrity !== SDK_COMPATIBILITY.ag_ui.integrity ||
    value.source.ag_ui_client_version !==
      SDK_COMPATIBILITY.ag_ui_client.version ||
    value.source.ag_ui_client_integrity !==
      SDK_COMPATIBILITY.ag_ui_client.integrity
  ) {
    return {
      valid: false,
      issues: ["fixture SDK versions or lock integrity do not match"],
    };
  }
  if (
    !Array.isArray(value.samples) ||
    value.samples.length !== SDK_COMPATIBILITY.routes.length
  ) {
    return {
      valid: false,
      issues: ["fixture must contain a sample for every locked route"],
    };
  }
  const operations: string[] = [];
  const packageByOperation: Record<string, string> = {
    info: `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
    run: `${SDK_COMPATIBILITY.ag_ui_client.package}@${SDK_COMPATIBILITY.ag_ui_client.version}`,
    connect: `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
    stop: `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
    threads_list: `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
  };
  const callsiteByOperation: Record<string, string> = {
    info: "AgentRegistry.fetchRuntimeInfo",
    run: "HttpAgent.requestInit/runAgent",
    connect: "ProxiedCopilotRuntimeAgent.#connectViaHttp",
    stop: "ProxiedCopilotRuntimeAgent.abortRun",
    threads_list: "createThreadFetchObservable",
  };
  for (const sample of value.samples) {
    if (
      !isRecord(sample) ||
      typeof sample.operation !== "string" ||
      !isRecord(sample.request) ||
      typeof sample.request.method !== "string" ||
      typeof sample.request.path !== "string" ||
      !isRecord(sample.response) ||
      typeof sample.response.status !== "number" ||
      !("body" in sample.response) ||
      !isRecord(sample.provenance) ||
      typeof sample.provenance.package !== "string" ||
      ![
        `${SDK_COMPATIBILITY.copilotkit.package}@${SDK_COMPATIBILITY.copilotkit.version}`,
        `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
        `${SDK_COMPATIBILITY.ag_ui.package}@${SDK_COMPATIBILITY.ag_ui.version}`,
        `${SDK_COMPATIBILITY.ag_ui_client.package}@${SDK_COMPATIBILITY.ag_ui_client.version}`,
      ].includes(sample.provenance.package) ||
      typeof sample.provenance.callsite !== "string" ||
      sample.provenance.callsite.length === 0 ||
      packageByOperation[sample.operation] !== sample.provenance.package ||
      callsiteByOperation[sample.operation] !== sample.provenance.callsite
    ) {
      return {
        valid: false,
        issues: ["one or more request/response samples are malformed"],
      };
    }
    operations.push(sample.operation);
    const route = SDK_COMPATIBILITY.routes[operations.length - 1];
    if (
      sample.request.method !== route.method ||
      !matchesRoutePath(sample.request.path, route.path)
    ) {
      return {
        valid: false,
        issues: [
          `${sample.operation}: request method/path does not match the locked route`,
        ],
      };
    }
    if (
      ["POST", "PUT", "PATCH"].includes(sample.request.method) &&
      sample.request.body === undefined &&
      sample.operation !== "stop"
    ) {
      return {
        valid: false,
        issues: [`${sample.operation}: request body is required`],
      };
    }
  }
  const expected = SDK_COMPATIBILITY.routes.map(({ operation }) => operation);
  if (operations.some((operation, index) => operation !== expected[index])) {
    return {
      valid: false,
      issues: ["sample operations must match the locked route order"],
    };
  }
  const runSample = value.samples.find(
    (sample) => isRecord(sample) && sample.operation === "run",
  );
  if (
    !isRecord(runSample) ||
    !isRecord(runSample.request) ||
    !isRecord(runSample.request.body) ||
    !isValidSDKRunBody(runSample.request.body)
  ) {
    return {
      valid: false,
      issues: [
        "run: request body is not accepted by locked AG-UI RunAgentInput",
      ],
    };
  }
  if (!isRecord(value.ui_contract))
    return { valid: false, issues: ["UI compatibility metadata is missing"] };
  for (const field of [
    "activity_event_types",
    "attachment_part_types",
    "tool_request_shapes",
  ] as const) {
    if (
      !Array.isArray(value.ui_contract[field]) ||
      value.ui_contract[field].some((item) => typeof item !== "string")
    ) {
      return {
        valid: false,
        issues: [`ui_contract.${field} must be a string array`],
      };
    }
  }
  if (
    !Array.isArray(value.platform_samples) ||
    value.platform_samples.length !== SDK_COMPATIBILITY.platform_routes.length
  ) {
    return {
      valid: false,
      issues: [
        "platform_samples must separately cover each planned platform-only route",
      ],
    };
  }
  for (const [index, sample] of value.platform_samples.entries()) {
    const route = SDK_COMPATIBILITY.platform_routes[index];
    if (
      !isRecord(sample) ||
      sample.operation !== route.operation ||
      !isRecord(sample.request) ||
      sample.request.method !== route.method ||
      typeof sample.request.path !== "string" ||
      !matchesRoutePath(sample.request.path, route.path) ||
      !isRecord(sample.provenance) ||
      sample.provenance.kind !== "planned_platform_contract"
    ) {
      return {
        valid: false,
        issues: [
          "platform_samples must remain labeled as planned platform contracts",
        ],
      };
    }
  }
  if (!isRecord(value.interactions)) {
    return { valid: false, issues: ["SDK interaction samples are missing"] };
  }
  const interactions = value.interactions;
  const interactionSources: Record<
    string,
    { package: string; callsite: string }
  > = {
    tool_result: {
      package: `${SDK_COMPATIBILITY.ag_ui.package}@${SDK_COMPATIBILITY.ag_ui.version}`,
      callsite: "ToolCallResultEventSchema",
    },
    approval_wait: {
      package: `${SDK_COMPATIBILITY.ag_ui.package}@${SDK_COMPATIBILITY.ag_ui.version}`,
      callsite: "RunFinishedInterruptOutcomeSchema",
    },
    approval_resume: {
      package: `${SDK_COMPATIBILITY.ag_ui_client.package}@${SDK_COMPATIBILITY.ag_ui_client.version}`,
      callsite: "HttpAgent.runAgent/requestInit",
    },
    reconnect: {
      package: `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
      callsite: "IntelligenceAgent.requestJoinCredentials$",
    },
    history_replay: {
      package: `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
      callsite: "ProxiedCopilotRuntimeAgent.#connectViaHttp",
    },
  };
  for (const field of [
    "tool_result",
    "approval_wait",
    "approval_resume",
    "reconnect",
    "history_replay",
  ] as const) {
    if (
      !isRecord(interactions[field]) ||
      !isRecord(interactions[field].provenance)
    ) {
      return {
        valid: false,
        issues: [`interactions.${field} needs a locked-SDK provenance record`],
      };
    }
    const provenance = interactions[field].provenance;
    const allowedPackages = [
      `${SDK_COMPATIBILITY.copilotkit.package}@${SDK_COMPATIBILITY.copilotkit.version}`,
      `${SDK_COMPATIBILITY.copilotkit_core.package}@${SDK_COMPATIBILITY.copilotkit_core.version}`,
      `${SDK_COMPATIBILITY.ag_ui.package}@${SDK_COMPATIBILITY.ag_ui.version}`,
      `${SDK_COMPATIBILITY.ag_ui_client.package}@${SDK_COMPATIBILITY.ag_ui_client.version}`,
    ];
    if (
      provenance.kind !== "locked_package_callsite" ||
      typeof provenance.package !== "string" ||
      !allowedPackages.includes(provenance.package) ||
      provenance.package !== interactionSources[field]?.package ||
      typeof provenance.file !== "string" ||
      provenance.callsite !== interactionSources[field]?.callsite
    ) {
      return {
        valid: false,
        issues: [
          `interactions.${field} provenance does not identify a locked SDK call site`,
        ],
      };
    }
  }
  const reconnect = interactions.reconnect;
  if (
    !isRecord(reconnect) ||
    !isRecord(reconnect.request) ||
    !isRecord(reconnect.request.body) ||
    typeof reconnect.request.body.lastSeenEventId !== "string" ||
    !isRecord(reconnect.response) ||
    reconnect.response.status !== 200 ||
    !isRecord(reconnect.response.body) ||
    typeof reconnect.response.body.joinToken !== "string" ||
    !isRecord(reconnect.response.body.realtime) ||
    !Array.isArray(reconnect.replayed_events) ||
    reconnect.replayed_events.length === 0 ||
    !isRecord(reconnect.channel_join) ||
    reconnect.channel_join.stream_mode !== "connect" ||
    reconnect.channel_join.last_seen_event_id !==
      reconnect.request.body.lastSeenEventId
  ) {
    return {
      valid: false,
      issues: [
        "reconnect sample must contain cursor-bearing credentials and replayed Phoenix events",
      ],
    };
  }
  const historyReplay = interactions.history_replay;
  if (
    !isRecord(historyReplay) ||
    !isRecord(historyReplay.request) ||
    !isRecord(historyReplay.response) ||
    !isRecord(historyReplay.response.body) ||
    !Array.isArray(historyReplay.response.body.events) ||
    historyReplay.response.body.events.length === 0
  ) {
    return {
      valid: false,
      issues: ["history replay must contain captured SSE events"],
    };
  }
  if (
    !isRecord(value.sse_response) ||
    value.sse_response.content_type !== "text/event-stream" ||
    !Array.isArray(value.sse_response.events) ||
    value.sse_response.events.length === 0 ||
    !isRecord(value.sse_response.provenance) ||
    value.sse_response.provenance.kind !== "locked_package_callsite"
  ) {
    return {
      valid: false,
      issues: ["representative SSE response events are missing"],
    };
  }
  return { valid: true };
}

function matchesRoutePath(actualPath: string, routePath: string): boolean {
  const pathname = actualPath.split("?", 1)[0] ?? actualPath;
  const pattern = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[a-z_]+/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(pathname);
}

function isValidSDKRunBody(body: Record<string, unknown>): boolean {
  return (
    typeof body.threadId === "string" &&
    typeof body.runId === "string" &&
    typeof body.protocolVersion === "string" &&
    Array.isArray(body.messages) &&
    body.state !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
