import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { sharedUseKeys } from "@/lib/plugins/shared-use";

/** The selection pair a scoped call rides, spread into the client options (MT086). */
type ScopePair = { tenantId?: string; workspaceId?: string };

export type ResponsibilityRecord = {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string;
  title: string;
  instruction: string;
  successCriteria: string;
  status: "active" | "paused" | "completed";
  progress: string;
  lastResult: string | null;
  subscriptions: {
    source:
      | "manual"
      | "slack"
      | "github"
      | "schedule"
      | "connector"
      | "webhook"
      | "linear"
      | "sentry"
      | "pagerduty"
      | "email";
    eventType: string;
  }[];
  updatedAt: string;
};
export type ResponsibilityRunRecord = {
  id: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "skipped";
  replyText: string | null;
  error: string | null;
  waiting: { kind: string; requestId?: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};
export type GithubBindingRecord = {
  id: string;
  source: "github";
  repository: string;
  createdAt: string;
  webhookPath?: string;
};
export const responsibilityKeys = {
  all: ["responsibilities"] as const,
  runs: (id: string) => ["responsibilities", id, "runs"] as const,
  bindings: ["responsibilities", "github-bindings"] as const,
  triggers: (id: string) => ["responsibilities", id, "triggers"] as const,
};
export function responsibilitiesQueryOptions() {
  return queryOptions({
    queryKey: responsibilityKeys.all,
    queryFn: (): Promise<ResponsibilityRecord[]> =>
      client("/api/responsibilities", "responsibilities", {
        fallbackKey: "responsibilities.load",
      }),
    refetchInterval: 10_000,
  });
}

// ---------------------------------------------------------------------------
// The scoped half (MT086 / Issue #129): the responsibilities page reads and writes through here
// ---------------------------------------------------------------------------

/**
 * The refusal a scoped responsibilities read raises when the server answers that the surface is
 * not this person's to hold under the scope they carry. One state for the page to answer with —
 * never a blank list, which would read as "no responsibilities" over "no access" (MT086 AC2).
 */
export class ResponsibilitiesUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Responsibilities are not available under the scope you hold.");
    this.name = "ResponsibilitiesUnavailableError";
    this.status = status;
  }
}

/**
 * The responsibilities list, bound to the scope the screen holds (MT086 / Issue #129, AC1): keyed
 * under the scope's own cache prefix (MT083), carrying the selection pair, and answered through
 * the same generation guard every scoped read passes.
 */
export function scopedResponsibilitiesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...responsibilityKeys.all]
        : [...responsibilityKeys.all, ":scope-pending"],
    enabled: open !== null,
    refetchInterval: 10_000,
    queryFn:
      open === null
        ? () => new Promise<ResponsibilityRecord[]>(() => {})
        : async ({ signal }): Promise<ResponsibilityRecord[]> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient("/api/responsibilities", {
                signal,
                fallbackKey: "responsibilities.load",
                ...(open.selection ?? {}),
              });
              if (response.status === 404) {
                throw new ResponsibilitiesUnavailableError(response.status);
              }
              if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                  error?: unknown;
                } | null;
                throw new Error(
                  typeof body?.error === "string"
                    ? body.error
                    : "Responsibilities could not be read.",
                );
              }
              const body = (await response.json().catch(() => null)) as {
                responsibilities?: ResponsibilityRecord[];
              } | null;
              if (body === null || !Array.isArray(body.responsibilities)) {
                throw new Error("Responsibilities could not be read.");
              }
              return body.responsibilities;
            }),
  });
}
export function responsibilityRunsQueryOptions(id: string) {
  return queryOptions({
    queryKey: responsibilityKeys.runs(id),
    queryFn: (): Promise<ResponsibilityRunRecord[]> =>
      client(`/api/responsibilities/${encodeURIComponent(id)}/runs`, "runs", {
        fallbackKey: "responsibilities.loadRuns",
      }),
    refetchInterval: 10_000,
  });
}
export function githubBindingsQueryOptions() {
  return queryOptions({
    queryKey: responsibilityKeys.bindings,
    queryFn: (): Promise<GithubBindingRecord[]> =>
      client("/api/responsibilities/sources/github", "bindings", {
        fallbackKey: "responsibilities.loadSources",
      }),
  });
}
export function createResponsibility(
  input: {
    agentId: string;
    channelId: string;
    title: string;
    instruction: string;
    successCriteria: string;
    subscriptions: ResponsibilityRecord["subscriptions"];
  },
  scope?: ScopePair,
) {
  return client<ResponsibilityRecord>(
    "/api/responsibilities",
    "responsibility",
    {
      method: "POST",
      body: input,
      fallbackKey: "responsibilities.create",
      ...(scope ?? {}),
    },
  );
}
export function updateResponsibility(
  id: string,
  patch: { title: string; instruction: string; successCriteria: string },
  scope?: ScopePair,
) {
  return client(`/api/responsibilities/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
    fallbackKey: "responsibilities.update",
    ...(scope ?? {}),
  });
}
export function responsibilityAction(
  id: string,
  action: "pause" | "resume" | "complete" | "run",
  scope?: ScopePair,
) {
  return client(`/api/responsibilities/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    fallbackKey: "responsibilities.change",
    ...(scope ?? {}),
  });
}
export function createGithubBinding(repository: string, secret: string) {
  return client<GithubBindingRecord>(
    "/api/responsibilities/sources/github",
    "binding",
    {
      method: "POST",
      body: { repository, secret },
      fallbackKey: "responsibilities.connect",
    },
  );
}
export function removeGithubBinding(id: string) {
  return client(
    `/api/responsibilities/sources/github/${encodeURIComponent(id)}`,
    { method: "DELETE", fallbackKey: "responsibilities.disconnect" },
  );
}

export type TriggerKind =
  | "webhook"
  | "github"
  | "linear"
  | "sentry"
  | "pagerduty"
  | "email"
  | "slack";
export type TriggerFilter = {
  eventTypes: string[];
  field?: { path: string; equals: string };
};
export type TriggerConfig =
  | {
      kind: "webhook" | "linear" | "sentry" | "pagerduty";
      filter: TriggerFilter;
    }
  | { kind: "github"; repository?: string; filter: TriggerFilter }
  | { kind: "email"; allowedSenders: string[]; filter: TriggerFilter }
  | {
      kind: "slack";
      teamId: string;
      mode: "mention" | "phrase" | "reaction" | "message";
      phrases: string[];
      reactions: string[];
      channels: string[];
    };
export type TriggerRecord = {
  id: string;
  responsibilityId: string;
  kind: TriggerKind;
  config: TriggerConfig;
  hasSecret: boolean;
  /** Paused triggers acknowledge deliveries but never start a run. */
  enabled: boolean;
  /** Public path to POST to, for webhook and provider kinds. */
  path: string | null;
  /** Inbound address, for email when the deployment has inbound email configured. */
  address: string | null;
  emailConfigured?: boolean;
  createdAt: string;
};
export function triggersQueryOptions(id: string) {
  return queryOptions({
    queryKey: responsibilityKeys.triggers(id),
    queryFn: (): Promise<TriggerRecord[]> =>
      client(
        `/api/responsibilities/${encodeURIComponent(id)}/triggers`,
        "triggers",
        { fallbackKey: "responsibilities.loadTriggers" },
      ),
  });
}
export async function createTrigger(
  responsibilityId: string,
  input: { config: TriggerConfig; secret?: string },
) {
  const response = await client(
    `/api/responsibilities/${encodeURIComponent(responsibilityId)}/triggers`,
    { method: "POST", body: input, fallbackKey: "responsibilities.addTrigger" },
  );
  return (await response.json()) as {
    trigger: TriggerRecord;
    secret: string | null;
  };
}
/** Rotate a generated secret, or store the provider's newly pasted one. */
export async function setTriggerSecret(triggerId: string, secret?: string) {
  const response = await client(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}/secret`,
    {
      method: "POST",
      body: secret ? { secret } : {},
      fallbackKey: "responsibilities.changeTriggerSecret",
    },
  );
  return (await response.json()) as {
    trigger: TriggerRecord;
    secret: string | null;
  };
}
export function revealTriggerSecret(triggerId: string) {
  return client<string>(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}/secret`,
    "secret",
    { fallbackKey: "responsibilities.readTriggerSecret" },
  );
}
export function removeTrigger(triggerId: string) {
  return client(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}`,
    { method: "DELETE", fallbackKey: "responsibilities.removeTrigger" },
  );
}

export function setTriggerEnabled(triggerId: string, enabled: boolean) {
  return client(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}/enabled`,
    {
      method: "PUT",
      body: { enabled },
      fallbackKey: "responsibilities.changeTrigger",
    },
  );
}

const settleGithub = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: responsibilityKeys.bindings });

export function createGithubBindingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      repository,
      secret,
    }: {
      repository: string;
      secret: string;
    }) => createGithubBinding(repository, secret),
    onSettled: settleGithub(queryClient),
  });
}
export function removeGithubBindingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: removeGithubBinding,
    onSettled: settleGithub(queryClient),
  });
}

/**
 * The scope the writes here submit under (MT086 / Issue #129, AC1): an open scope's selection
 * rides the request, and a pending one submits nothing.
 */
function scopePair(
  scope: ScopedCache | undefined,
): ScopePair | undefined {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : undefined;
}

const settleResponsibilities = (queryClient: QueryClient, scope?: ScopedCache) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: responsibilityKeys.all }),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...responsibilityKeys.all],
          }),
        ]
      : []),
  ]);

export function createResponsibilityMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (input: Parameters<typeof createResponsibility>[0]) =>
      createResponsibility(input, scopePair(scope)),
    onSuccess: settleResponsibilities(queryClient, scope),
  });
}

export function updateResponsibilityMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { title: string; instruction: string; successCriteria: string };
    }) => updateResponsibility(id, patch, scopePair(scope)),
    onSuccess: settleResponsibilities(queryClient, scope),
  });
}

/** Pause, resume, complete or run a responsibility now. */
export function responsibilityActionMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resume" | "complete" | "run";
    }) => responsibilityAction(id, action, scopePair(scope)),
    onSuccess: settleResponsibilities(queryClient, scope),
  });
}

const settleTriggers = (queryClient: QueryClient, responsibilityId: string) =>
  queryClient.invalidateQueries({
    queryKey: responsibilityKeys.triggers(responsibilityId),
  });

/**
 * Add a trigger. A new trigger is a new way a shared app gets called, so the approval it needs may
 * have changed: the shared-use requests are refreshed alongside the triggers.
 */
export function createTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      responsibilityId,
      input,
    }: {
      responsibilityId: string;
      input: { config: TriggerConfig; secret?: string };
    }) => createTrigger(responsibilityId, input),
    onSuccess: async (_created, { responsibilityId }) => {
      await settleTriggers(queryClient, responsibilityId);
      await queryClient.invalidateQueries({
        queryKey: sharedUseKeys.requests(),
      });
    },
  });
}

/**
 * Read a trigger's write-only secret on demand. No `queryClient` and no `onSuccess`: it changes
 * nothing and caches nothing, so there is nothing to invalidate, and the secret lives only in the
 * row that asked for it.
 */
export function revealTriggerSecretMutationOptions() {
  return mutationOptions({ mutationFn: revealTriggerSecret });
}

/** Rotate a generated secret, or store the provider's newly pasted one. */
export function setTriggerSecretMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      trigger,
      secret,
    }: {
      trigger: Pick<TriggerRecord, "id" | "responsibilityId">;
      secret?: string;
    }) => setTriggerSecret(trigger.id, secret),
    onSuccess: (_result, { trigger }) =>
      settleTriggers(queryClient, trigger.responsibilityId),
  });
}

export function removeTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (trigger: Pick<TriggerRecord, "id" | "responsibilityId">) =>
      removeTrigger(trigger.id),
    onSuccess: (_result, trigger) =>
      settleTriggers(queryClient, trigger.responsibilityId),
  });
}

/** Switch a trigger on or off; a paused trigger acknowledges deliveries but never starts a run. */
export function setTriggerEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      trigger,
      enabled,
    }: {
      trigger: Pick<TriggerRecord, "id" | "responsibilityId">;
      enabled: boolean;
    }) => setTriggerEnabled(trigger.id, enabled),
    onSuccess: (_result, { trigger }) =>
      settleTriggers(queryClient, trigger.responsibilityId),
  });
}
