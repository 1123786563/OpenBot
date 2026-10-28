/**
 * The F09 workspace transfer: copy one stored PDF version into the owner's
 * private Bot workspace under a server-derived path (contracts §5).
 *
 * TASK 0 SEAM CITATION (recorded, per plan): the server's only write into a
 * Bot workspace today is `ComputerGateway.writeFile` (server/src/computer/
 * gateway.ts:1230, interface at :206) over `POST /files/write`, answered by
 * `workspace.write` in agent-computer/src/workspace.ts:332 — utf8 TEXT with a
 * 1,000,000-byte default cap (agent-computer/src/workspace.ts:95). That seam
 * exists, so this module rides it; but it cannot carry a binary PDF
 * faithfully (utf8 re-encoding corrupts bytes ≥ 0x80, and base64 both breaks
 * the 1 MiB cap for most PDFs and would not be a usable PDF artifact). The
 * injected filesystem therefore speaks BYTES: production wiring — owned by
 * index.ts, not this ticket — maps it onto the gateway once a binary-capable
 * write (or decode) exists, and needs no change here.
 *
 * ROUND 6 (M25) DEPENDENCY, made explicit for the wiring ticket: the gateway
 * must gain BOTH verbs this module's cleanup promise needs — a BINARY-CAPABLE
 * WRITE for the artifact and a REMOVE (delete) for the half-written
 * artifact's cleanup (§5: a partial transfer never reports completion).
 * Neither exists on ComputerGateway today; wiring transfer without both
 * would ship the ledger logic on a seam that cannot honor its failure path.
 *
 * IDEMPOTENCY STORAGE DECISION (recorded, per plan): the transferKey →
 * artifact mapping lives in a json ledger INSIDE the workspace
 * (`openmuse-transfer/ledger.json`), the same pattern as craft/uploads.ts's
 * `.openbot-uploads.json` — the ledger rides the workspace, so a snapshot or
 * reset carries it with the very files it describes, and a retry after a
 * reset re-derives the same path rather than answering a stale one from a
 * table the workspace has forgotten. No migration: `openmuse_files` has no
 * jsonb metadata column, and a DB table could not see resets at all.
 */

/** The bot workspace as the transfer needs it: the gateway's three file
 * verbs plus the remove a partial transfer's cleanup needs (the gateway has
 * no delete method today — see the seam citation above). */
export type WorkspaceTransferFilesystem = {
  /** File paths under a folder, workspace-relative. */
  list(path: string): Promise<string[]>;
  /** A file's text, or null when absent — the ledger read. */
  read(path: string): Promise<string | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
};

export const TRANSFER_LEDGER_PATH = "openmuse-transfer/ledger.json";

/** One recorded transfer: `complete` is replayed on retry, `failed` never is. */
type LedgerEntry = {
  fileId: string;
  versionId: string;
  path: string;
  status: "complete" | "failed";
  at: string;
};

type TransferLedger = Record<string, LedgerEntry>;

/**
 * Entries a ledger keeps before it sheds: the evicted are failed first, then
 * oldest. The bound must fit the seam's SMALLEST cap, not just the write cap:
 * the workspace's text read truncates at 64,000 bytes (agent-computer's
 * DEFAULT_WORKSPACE_LIMITS.readBytes), and one 2-space-indented entry
 * serializes to roughly 300–530 bytes (transferKey alone can be 200
 * characters). Past the read cap the truncated JSON no longer parses, the
 * read degrades to an empty ledger, and the next write silently erases every
 * replay record; past the 1,000,000-byte write cap every future transfer's
 * ledger write fails and the transfer wedges on 503. 100 × 530 ≈ 53 KB —
 * under both caps with margin.
 */
const MAX_LEDGER_ENTRIES = 100;

/** Shape guard: a corrupt entry is dropped, never trusted (a bad path must
 * not collide, a bad status must not replay). */
function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fileId === "string" &&
    typeof entry.versionId === "string" &&
    typeof entry.path === "string" &&
    (entry.status === "complete" || entry.status === "failed") &&
    typeof entry.at === "string"
  );
}

/**
 * §5: `openmuse-transfer/<fileId>/<versionId>-<n>.pdf`, n from 1, skipping
 * every taken name so a same-name file is never overwritten. The client
 * supplies no destination — this is the only place a destination is born.
 */
export function deriveTransferPath(
  fileId: string,
  versionId: string,
  taken: ReadonlySet<string>,
): string {
  for (let n = 1; ; n++) {
    const path = `openmuse-transfer/${fileId}/${versionId}-${n}.pdf`;
    if (!taken.has(path)) {
      return path;
    }
  }
}

/** Absent or corrupt ledger reads degrade to empty — a bad ledger must not
 * block a transfer, only cost its retry shortcut (craft/uploads precedent).
 * The ledger is a null-prototype object: a transferKey like "__proto__" must
 * be an ordinary key (replayable), not a write to every object's prototype. */
async function readLedger(
  filesystem: WorkspaceTransferFilesystem,
): Promise<TransferLedger> {
  const ledger: TransferLedger = Object.create(null);
  const raw = await filesystem.read(TRANSFER_LEDGER_PATH);
  if (raw === null) {
    return ledger;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return ledger;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (isLedgerEntry(value)) {
        ledger[key] = value;
      }
    }
    return ledger;
  } catch {
    return ledger;
  }
}

function ledgerBytes(ledger: TransferLedger): Uint8Array {
  const entries = Object.entries(ledger);
  if (entries.length > MAX_LEDGER_ENTRIES) {
    entries
      .sort(
        ([, a], [, b]) =>
          Number(a.status === "complete") - Number(b.status === "complete") ||
          a.at.localeCompare(b.at),
      )
      .slice(0, entries.length - MAX_LEDGER_ENTRIES)
      .forEach(([key]) => {
        delete ledger[key];
      });
  }
  return new TextEncoder().encode(JSON.stringify(ledger, null, 2));
}

export type WorkspaceTransferOutcome =
  | { kind: "transferred"; path: string }
  | { kind: "replayed"; path: string }
  | { kind: "failed" };

/**
 * Copy the version's bytes into the workspace under a derived path, then
 * record the artifact. A complete ledger entry for the same
 * transferKey+version replays its path with zero writes. Any failure —
 * either write — cleans the partial artifact and marks the key failed, so a
 * partial transfer is never reported complete (§5); the caller answers 503.
 */
export async function transferVersionToWorkspace(input: {
  filesystem: WorkspaceTransferFilesystem;
  fileId: string;
  versionId: string;
  transferKey: string;
  bytes: Uint8Array;
}): Promise<WorkspaceTransferOutcome> {
  const { filesystem, fileId, versionId, transferKey, bytes } = input;
  const ledger = await readLedger(filesystem);
  const settled = ledger[transferKey];
  if (
    settled?.status === "complete" &&
    settled.fileId === fileId &&
    settled.versionId === versionId
  ) {
    return { kind: "replayed", path: settled.path };
  }
  /*
   * Collision truth: what the workspace lists under the file's folder — a
   * Bot-written file of the same name counts — plus every completed artifact
   * the ledger knows, so a truncated listing cannot cause an overwrite of a
   * LEDGER-known artifact (a Bot file beyond the listing seam's truncation
   * window can still collide; the seam's cap is the ceiling on that promise).
   */
  const taken = new Set(await filesystem.list(`openmuse-transfer/${fileId}`));
  for (const entry of Object.values(ledger)) {
    if (entry.status === "complete") {
      taken.add(entry.path);
    }
  }
  const path = deriveTransferPath(fileId, versionId, taken);
  const at = new Date().toISOString();
  try {
    await filesystem.write(path, bytes);
    // The entry-read ledger is a snapshot; re-reading before recording is
    // what the catch path already does, so a concurrent transfer's completed
    // entry survives this write instead of being erased by the later writer.
    const recorded = await readLedger(filesystem);
    recorded[transferKey] = { fileId, versionId, path, status: "complete", at };
    await filesystem.write(TRANSFER_LEDGER_PATH, ledgerBytes(recorded));
    return { kind: "transferred", path };
  } catch {
    /*
     * Cleaned or marked failed (§5 allows either; do both, best-effort).
     * The ledger is re-read first: two concurrent keys over one version
     * derive the same first-free path, and deleting a path another
     * completed key has since claimed would turn its replay into a ghost.
     * The failed marker also lands on the fresh copy, so recording this
     * failure cannot erase a concurrent transfer's completed entry.
     */
    const fresh = await readLedger(filesystem);
    const pathHeldByOtherComplete = Object.entries(fresh).some(
      ([key, entry]) =>
        key !== transferKey &&
        entry.status === "complete" &&
        entry.path === path,
    );
    if (!pathHeldByOtherComplete) {
      await filesystem.remove(path).catch(() => {});
    }
    fresh[transferKey] = { fileId, versionId, path, status: "failed", at };
    await filesystem
      .write(TRANSFER_LEDGER_PATH, ledgerBytes(fresh))
      .catch(() => {});
    return { kind: "failed" };
  }
}
