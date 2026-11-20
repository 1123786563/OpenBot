import { z } from "zod";
import { sign, verify } from "../auth/signed-value";

export const AUDIT_RUN_PROOF_KEY = "openbotAuditRunProof";
const label = (actorId: string) => `openbot:audit-run:${actorId}`;

type RunIdentity = { runId: string; threadId: string };
type RunLineage = {
  parentRunId?: string;
  rootTaskId?: string;
  attemptId?: string;
};

const claims = z.object({
  runId: z.string(),
  threadId: z.string(),
  parentRunId: z.string().optional(),
  rootTaskId: z.string().optional(),
  attemptId: z.string().optional(),
});

export function signAuditRun(
  run: RunIdentity & RunLineage,
  actorId: string,
  key: string,
): string {
  const value = Buffer.from(JSON.stringify(run)).toString("base64url");
  return sign(value, key, label(actorId));
}

export function auditRunProofOf(props: unknown): string | undefined {
  if (
    props &&
    typeof props === "object" &&
    !Array.isArray(props) &&
    AUDIT_RUN_PROOF_KEY in props
  ) {
    const proof = props[AUDIT_RUN_PROOF_KEY];
    if (typeof proof === "string" && proof.length <= 4096) return proof;
  }
}

export function readAuditRun(
  proof: string | undefined,
  run: RunIdentity,
  actorId: string,
  key: string,
): RunLineage | undefined {
  const value = verify(proof, key, label(actorId));
  if (!value) return;
  const parsed = claims.safeParse(
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
  );
  if (!parsed.success) return;
  const { runId, threadId, ...lineage } = parsed.data;
  if (run.runId === runId && run.threadId === threadId) return lineage;
}
