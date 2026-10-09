/**
 * Re-export of `shared/src/brokered-provenance.ts` so browser code imports through `@/` and the
 * path to `shared/` is written once. See `@/lib/copilot/markers` for the pattern.
 */
export {
  BROKERED_PROVENANCES,
  isBrokeredProvenance,
} from "../../../shared/src/brokered-provenance";
export type { BrokeredProvenance } from "../../../shared/src/brokered-provenance";
