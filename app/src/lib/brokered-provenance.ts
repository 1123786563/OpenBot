/**
 * Re-export of `shared/src/brokered-provenance.ts` so browser code imports through `@/` and the
 * path to `shared/` is written once. See `@/lib/copilot/markers` for the pattern.
 */
export {
  BROKERED_PROVENANCES,
  isBrokeredProvenance,
} from "../../../shared/src/brokered-provenance";
export type { BrokeredProvenance } from "../../../shared/src/brokered-provenance";

/**
 * The display name and the env vars of the broker a row was enabled through, for sentences that
 * have to name them.
 *
 * ANYTHING UNRECOGNISED ANSWERS COMPOSIO, which keeps every pre-existing caller's rendering
 * byte-identical — the copy this replaces hardcoded Composio, so a fallback here is the old
 * behaviour, not a guess. The env half is what an unconfigured-broker sentence tells the operator
 * to set, and the two brokers genuinely differ: one key for Composio, two for OpenConnector.
 */
export function brokerDisplay(provenance: string | null | undefined): {
  name: string;
  env: string;
} {
  return provenance === "open-connector"
    ? {
        name: "OpenConnector",
        env: "OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN",
      }
    : { name: "Composio", env: "COMPOSIO_API_KEY" };
}
