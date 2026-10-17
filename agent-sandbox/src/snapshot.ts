import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The workspace snapshot and restore (S4): a Bot's whole working directory, as one archive.
 *
 * IN-PROCESS BY DESIGN. The first cut shelled out to `tar`; under `bun test --isolate` the
 * real child processes wedged the runner's later files (the proxy suite's internal fetches
 * hung 5 seconds each), and a snapshot path that behaves differently under test than in
 * production is a worse bet than a small, whole-file-in-memory tar writer. The workshop's
 * workspaces are small (artifacts and code, not datasets); gzip them whole, in-process.
 *
 * THE SENTINEL FILE is the archive's integrity claim: `.openbot-snapshot` rides at the root
 * of every archive this module writes, and a restore refuses any archive without one — a
 * swapped or truncated archive answers "not a snapshot" rather than extracting whatever it
 * happens to hold into a Bot's workspace.
 *
 * RESTORE REPLACES, NEVER MERGES: the old directory is removed first, so a restore is a
 * point-in-time statement rather than an overlay whose leftovers speak for a past nobody
 * restored to. The proxy refuses the restore while the Bot holds a live turn, and the
 * caller stops the serve before extracting — a workspace swapped under a live serve is a
 * serve whose memory lies about its files.
 *
 * THE WORKSPACE IS NOT ALWAYS SMALL, SO THE WALK PRUNES AND THE SIZE IS CAPPED. "Small"
 * holds for a workshop Bot's artifacts; it does not hold for a CRAFT workspace, which hosts
 * every session of a Bot and grows a ~700MB node_modules per scaffolded webapp. Measured
 * live: /workspace at 1.9GB, 1.43GB of it two sessions' dependency trees — and craft's idle
 * reaper snapshots it every 60s. Three in-memory copies of 1.9GB against a 2GiB container
 * limit is an OOM kill, not a slow request: the container went from 57MB idle to its hard
 * ceiling within 5s of a sweep tick and restarted, on a clean 60s period, forever (the
 * snapshot always failed, so the session never flipped idle and stayed a candidate). Every
 * restart took every session's dev server with it.
 *
 * So two guards, and they answer to different rules:
 * - PRUNE derived trees. Not because they are big, but because their entire contents are
 *   reproducible from files that ARE archived: package.json + bun.lock regenerate
 *   node_modules (craft's start-webapp.sh already reinstalls when node_modules/.bin/next is
 *   missing), a build regenerates .next, requirements regenerate .venv. Archiving them is
 *   both fatal and pointless. Pruning took that same live workspace from 1.9GB to 19MB.
 *   Real state is kept: .git is hidden but not derived, so it rides along.
 * - CAP the input. Whatever else fills a workspace, the answer must be a logged refusal the
 *   caller survives, never an allocation that takes the container down.
 */

export const SNAPSHOT_SENTINEL = ".openbot-snapshot";

/**
 * Directory names pruned whole, at any depth: trees whose contents are reproducible from
 * files this archive DOES carry. The test is derivability, not size and not visibility —
 * `.git` is hidden and stays, `dist` may be the deliverable and stays.
 */
export const PRUNED_DIRECTORIES = new Set([
  "node_modules", // ← package.json + bun.lock / package-lock.json
  ".next", // ← a Next.js build
  ".venv", // ← requirements.txt / pyproject.toml
  "__pycache__", // ← the sources beside it
]);

/**
 * The default input ceiling. This module holds the tree three times over (members, tar,
 * gzip), so the peak is ~3x this; 256MB peaks near 768MB, inside a 2GiB container with
 * room for everything else, and is ~13x the pruned craft workspace measured live (19MB).
 */
export const DEFAULT_SNAPSHOT_MAX_INPUT_BYTES = 256 * 1024 * 1024;

/** Raised instead of allocating past the ceiling — see the head's CAP rule. */
export class SnapshotTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxInputBytes: number,
  ) {
    super(
      `workspace snapshot refused: ${bytes} bytes of content exceeds the ${maxInputBytes} byte ceiling`,
    );
    this.name = "SnapshotTooLargeError";
  }
}

export type SnapshotOptions = {
  /** The Bot's workspace directory — the archive's whole world. */
  botWorkspace: string;
  /** The sentinel's content: the bot id and the moment, for an operator's eyes. */
  botId: string;
  /**
   * Ceiling on the bytes the walk may collect, before tar and gzip. Exceeding it throws
   * SnapshotTooLargeError rather than growing the allocation into the container's limit.
   */
  maxInputBytes?: number;
};

/** One in-memory archive: the gzipped bytes of the workspace tree. */
export type SnapshotArchive = Uint8Array;

/** The archive's byte form, as the HTTP route streams it. */
export async function createSnapshot(
  options: SnapshotOptions,
): Promise<SnapshotArchive> {
  await writeFile(
    join(options.botWorkspace, SNAPSHOT_SENTINEL),
    `${options.botId}\n${new Date().toISOString()}\n`,
    "utf8",
  );
  const files = await walk(options.botWorkspace, options.botWorkspace, {
    maxInputBytes: options.maxInputBytes ?? DEFAULT_SNAPSHOT_MAX_INPUT_BYTES,
    bytes: 0,
  });
  return gzipSync(tarBytes(files));
}

/** Whether the archive holds the sentinel — the only archive this module restores. */
export async function snapshotHasSentinel(
  archive: SnapshotArchive,
): Promise<boolean> {
  try {
    const files = untarBytes(gunzipSync(archive));
    return files.some((file) => file.path === SNAPSHOT_SENTINEL);
  } catch {
    return false;
  }
}

/** Extract into the Bot's workspace: replace, never merge (see the head). */
export async function restoreArchive(
  archive: SnapshotArchive,
  botWorkspace: string,
): Promise<{ ok: true } | { ok: false; reason: "no-sentinel" }> {
  if (!(await snapshotHasSentinel(archive))) {
    return { ok: false, reason: "no-sentinel" };
  }
  let files: Array<{ path: string; bytes: Uint8Array }>;
  try {
    files = untarBytes(gunzipSync(archive));
  } catch {
    return { ok: false, reason: "no-sentinel" };
  }
  await rm(botWorkspace, { recursive: true, force: true });
  await mkdir(botWorkspace, { recursive: true });
  for (const file of files) {
    // The containment rule, restated: a member that escapes the target is dropped, not
    // written wherever it points — archives from this module never carry one, but the
    // refusal costs three lines and the assumption costs an incident.
    if (file.path.startsWith("/") || file.path.split("/").includes(".."))
      continue;
    const target = join(botWorkspace, file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.bytes);
  }
  return { ok: true };
}

// ── the minimal tar, ustar long-enough ────────────────────────────────────────

type TarMember = { path: string; bytes: Uint8Array };

/**
 * The walk, pruning derived directories whole and refusing to collect past the ceiling.
 * The check is per file as it is read, so the throw lands at the moment the budget is
 * exceeded rather than after the whole tree is already resident — and the running total
 * rides one shared budget object, so the error always names the caller's real ceiling
 * rather than whatever slice of it a nested directory happened to be handed.
 */
type WalkBudget = { readonly maxInputBytes: number; bytes: number };

async function walk(
  root: string,
  dir: string,
  budget: WalkBudget,
): Promise<TarMember[]> {
  const out: TarMember[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PRUNED_DIRECTORIES.has(entry.name)) continue;
      out.push(...(await walk(root, full, budget)));
    } else if (entry.isFile()) {
      const content = await readFile(full);
      budget.bytes += content.length;
      if (budget.bytes > budget.maxInputBytes) {
        throw new SnapshotTooLargeError(budget.bytes, budget.maxInputBytes);
      }
      out.push({
        path: full.slice(root.length + 1),
        bytes: new Uint8Array(content),
      });
    }
  }
  return out;
}

const HEADER = 512;

function tarBytes(members: TarMember[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const member of members) {
    chunks.push(Buffer.from(tarHeader(member.path, member.bytes.length)));
    chunks.push(Buffer.from(member.bytes));
    const pad = (HEADER - (member.bytes.length % HEADER)) % HEADER;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(HEADER * 2)); // two zero blocks end the archive
  return new Uint8Array(Buffer.concat(chunks));
}

/** One ustar header: enough of the format for our own reader, and no more. */
function tarHeader(path: string, size: number): Uint8Array {
  const header = Buffer.alloc(HEADER, 0);
  header.write(path.slice(0, 100), 0, "utf8");
  header.write("000644\0", 100, "ascii"); // mode
  header.write("0000000\0", 108, "ascii"); // uid
  header.write("0000000\0", 116, "ascii"); // gid
  // Size as octal, zero-padded to 11, NUL-terminated.
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii"); // mtime: "now" is a lie we refuse to tell
  header.write("        ", 148, "ascii"); // checksum placeholder: 8 spaces
  header.write("0", 156, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  // The checksum: the header's bytes summed as unsigned, written as 6 octal digits + NUL + space.
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return new Uint8Array(header);
}

function untarBytes(archive: Uint8Array): TarMember[] {
  const out: TarMember[] = [];
  const view = Buffer.from(archive);
  let at = 0;
  while (at + HEADER <= view.length) {
    const header = view.subarray(at, at + HEADER);
    if (header.every((byte) => byte === 0)) break; // the end blocks
    const path = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const sizeField = header
      .toString("ascii", 124, 136)
      .replace(/\0.*$/, "")
      .trim();
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size)) break;
    at += HEADER;
    out.push({ path, bytes: new Uint8Array(view.subarray(at, at + size)) });
    at += size + ((HEADER - (size % HEADER)) % HEADER);
  }
  return out;
}
