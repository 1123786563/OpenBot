/**
 * Domain scenario registry for the multitenancy isolation suites.
 *
 * Contract source: `docs/plans/2026-10-15-company-team-multitenancy/interfaces.md`
 * (T01 shared interface). Every backend multitenancy test domain registers one
 * adapter here; the acceptance harness (MT131) runs scenarios only through this
 * registry so no ticket can quietly substitute a preset success for real
 * observations.
 */

/** What one executed scenario actually observed. Facts, never verdicts. */
export type IsolationObservation = Readonly<{
  positiveControlPassed: boolean;
  denied: boolean;
  leakedRecords: readonly unknown[];
  forbiddenEffects: readonly unknown[];
}>;

/** Implemented beside each domain's real tests; runs its scenarios for real. */
export interface DomainScenarioAdapter {
  run(scenarioId: string): Promise<IsolationObservation>;
}

/**
 * The union of backend task `test` fields in
 * `docs/plans/2026-10-15-company-team-multitenancy/tasks.json`. A domain that
 * gains a task gets its name here in the same change; unknown names are
 * refused at runtime as well as at compile time.
 */
export const ISOLATION_DOMAINS = [
  "admin-audit",
  "assembly",
  "billing-accounts",
  "bots",
  "conversations",
  "craft-workshop",
  "credentials",
  "desktop-native",
  "desktop-selection",
  "execution",
  "full-coverage",
  "inventory",
  "jobs",
  "knowledge-memory",
  "memberships",
  "migration",
  "mobile-selection",
  "openmuse-connectors-deletion",
  "openmuse-personal",
  "plugins-approvals",
  "resource-policy",
  "runtime-config",
  "telemetry",
  "web-governance",
  "web-selection",
  "web-workbench",
] as const satisfies readonly string[];

export type IsolationDomain = (typeof ISOLATION_DOMAINS)[number];

const KNOWN_DOMAINS: ReadonlySet<string> = new Set(ISOLATION_DOMAINS);

const adapters = new Map<IsolationDomain, DomainScenarioAdapter>();

function assertKnownDomain(domain: string): asserts domain is IsolationDomain {
  if (!KNOWN_DOMAINS.has(domain)) {
    throw new Error(
      `UNKNOWN_ISOLATION_DOMAIN:${domain}: expected one of ${ISOLATION_DOMAINS.join(", ")}`,
    );
  }
}

/** Registers the one adapter for a domain. Re-registration is an error. */
export function registerIsolationDomain(
  domain: IsolationDomain,
  adapter: DomainScenarioAdapter,
): void {
  assertKnownDomain(domain);
  if (typeof adapter?.run !== "function") {
    throw new Error(`ISOLATION_ADAPTER_INVALID:${domain}`);
  }
  if (adapters.has(domain)) {
    throw new Error(`ISOLATION_DOMAIN_ALREADY_REGISTERED:${domain}`);
  }
  adapters.set(domain, adapter);
}

/**
 * Runs one scenario through the domain's registered adapter. Unregistered
 * domains, adapter failures, and skip-shaped results are errors — this
 * function never manufactures a passing observation.
 */
export async function runIsolationScenario(
  domain: IsolationDomain,
  scenarioId: string,
): Promise<IsolationObservation> {
  assertKnownDomain(domain);
  if (typeof scenarioId !== "string" || !scenarioId.trim()) {
    throw new Error("SCENARIO_ID_REQUIRED");
  }
  const adapter = adapters.get(domain);
  if (!adapter) {
    throw new Error(
      `ISOLATION_DOMAIN_NOT_REGISTERED:${domain}: register an adapter beside the domain's tests first`,
    );
  }
  let observation: IsolationObservation;
  try {
    observation = await adapter.run(scenarioId);
  } catch (error) {
    throw new Error(`ISOLATION_SCENARIO_FAILED:${domain}:${scenarioId}`, {
      cause: error,
    });
  }
  if (!isValidObservation(observation)) {
    throw new Error(
      `ISOLATION_OBSERVATION_INVALID:${domain}:${scenarioId}: adapters must report real facts, not skip`,
    );
  }
  return observation;
}

/** The domains that currently have a registered adapter. */
export function registeredIsolationDomains(): readonly IsolationDomain[] {
  return [...adapters.keys()];
}

/** Test-support reset so registry tests cannot depend on file order. */
export function clearIsolationDomainRegistrations(): void {
  adapters.clear();
}

function isValidObservation(
  observation: IsolationObservation,
): observation is IsolationObservation {
  return (
    observation !== null &&
    typeof observation === "object" &&
    typeof observation.positiveControlPassed === "boolean" &&
    typeof observation.denied === "boolean" &&
    Array.isArray(observation.leakedRecords) &&
    Array.isArray(observation.forbiddenEffects)
  );
}
