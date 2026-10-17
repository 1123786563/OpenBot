/**
 * The workshop's file surface: browsing the sandbox tree, and uploading into it under limits.
 *
 * THE LIMITS ARE THE PRODUCT DECISION HERE. An upload is a person's data crossing into code
 * execution, so the caps are enforced server-side and the refusal is audited BEFORE the caller
 * is told — the same record-first order the gateway holds for runs, so an upload that was
 * refused still leaves a row saying who tried and why it was turned away.
 */
import { recordAuditEvent, type AuditStore } from "../audit";
import type { SandboxClient } from "../codesandbox/client";
import type { WorkshopStore } from "./store";

/** At most this many files in one upload request. */
export const MAX_UPLOAD_FILES = 20;
/** At most this many bytes in any one file. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** At most this many bytes written by one request in total. */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export class UploadLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadLimitError";
  }
}

/** The tree node the gallery renders; shape-matched to the app's client type. */
export type WorkshopFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  truncated?: boolean;
  children?: WorkshopFileNode[];
};

/** What the workshop files module needs from its host. */
export type WorkshopFilesOptions = {
  store: WorkshopStore & {
    /** The session lookup by id — browsing and uploading address sessions, not channels. */
    sessionById(
      id: string,
    ): Promise<{ id: string; botId: string; ownerUserId: string } | undefined>;
  };
  auditStore?: AuditStore;
  /** Which Bot's sandbox this deployment talks to, or null where none is configured. */
  clientFor: (botId: string) => SandboxClient | null;
  actorUserId: string;
};

export type UploadInput = Array<{ name: string; content: string }>;

export type UploadResult = {
  uploaded: Array<{ path: string; size: number }>;
};

/**
 * The workspace tree at `path`, grouped from the sandbox's flat listing.
 *
 * A directory appears the moment anything beneath it exists; file sizes are best-effort (a
 * listing that cannot be read answers 0 rather than failing the tree).
 */
export async function listTree(
  options: WorkshopFilesOptions,
  sessionId: string,
  path = "",
): Promise<WorkshopFileNode[]> {
  const session = await options.store.sessionById(sessionId);
  if (!session) throw new Error(`No workshop session ${sessionId}.`);
  const client = options.clientFor(session.botId);
  if (!client) return [];

  const prefix = path.replace(/\/$/, "");
  const files = await client.listFiles();
  const scoped = prefix
    ? files.filter((file) => file.startsWith(`${prefix}/`))
    : files;

  const directories = new Map<string, WorkshopFileNode>();
  const nodes: WorkshopFileNode[] = [];

  for (const file of scoped) {
    const relative = prefix ? file.slice(prefix.length + 1) : file;
    const segments = relative.split("/");
    if (segments.length === 1) {
      const detail = await client.readFile(file, 1).catch(() => undefined);
      nodes.push({
        name: segments[0],
        path: file,
        type: "file",
        size: detail?.size ?? 0,
      });
      continue;
    }
    // Nest intermediate directories, creating each on first sight. The final
    // segment is the file itself; every earlier one is a directory that exists.
    const fileName = segments.at(-1);
    if (fileName === undefined) continue;
    let parent: WorkshopFileNode | undefined;
    let parentPath = prefix;
    for (const segment of segments.slice(0, -1)) {
      parentPath = parentPath ? `${parentPath}/${segment}` : segment;
      let directory = directories.get(parentPath);
      if (!directory) {
        directory = {
          name: segment,
          path: parentPath,
          type: "directory",
          size: 0,
          children: [],
        };
        directories.set(parentPath, directory);
        if (parent) parent.children?.push(directory);
        else nodes.push(directory);
      }
      parent = directory;
    }
    if (parent) {
      parent.children?.push({
        name: fileName,
        path: file,
        type: "file",
        size: 0,
      });
    }
  }
  return nodes;
}

/**
 * Upload files into the session's workspace: limits first, audit before refusal.
 *
 * The order is load-bearing: every refusal writes its `workshop.file_upload_refused` row and
 * AWAITS it before throwing, so there is no observable state where the caller was rejected and
 * the trail stayed silent. A successful batch writes one `workshop.file_uploaded` row — not one
 * per file, because the trail answers "who uploaded what" and twenty rows per drag-and-drop
 * bury it.
 */
export async function upload(
  options: WorkshopFilesOptions,
  sessionId: string,
  files: UploadInput,
): Promise<UploadResult> {
  const session = await options.store.sessionById(sessionId);
  if (!session) throw new Error(`No workshop session ${sessionId}.`);

  const refuse = async (
    reason: string,
    detail: Record<string, unknown>,
  ): Promise<never> => {
    if (options.auditStore) {
      await recordAuditEvent(options.auditStore, {
        eventType: "workshop.file_upload_refused",
        targetType: "workshop_session",
        targetId: sessionId,
        actorUserId: options.actorUserId,
        payload: { bot: session.botId, reason, ...detail },
      });
    }
    throw new UploadLimitError(reason);
  };

  if (files.length === 0) {
    await refuse("The upload carried no files.", { count: 0 });
  }
  if (files.length > MAX_UPLOAD_FILES) {
    await refuse(
      `An upload may carry at most ${MAX_UPLOAD_FILES} files; this one carried ${files.length}.`,
      { count: files.length },
    );
  }

  const sizes = files.map((file) => Buffer.byteLength(file.content, "utf8"));
  for (const file of files) {
    const size = Buffer.byteLength(file.content, "utf8");
    if (size > MAX_UPLOAD_BYTES) {
      await refuse(
        `The file ${file.name} exceeds the ${MAX_UPLOAD_BYTES}-byte per-file limit.`,
        { file: file.name, size },
      );
    }
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > MAX_TOTAL_BYTES) {
    await refuse(
      `The upload totals ${total} bytes and exceeds the ${MAX_TOTAL_BYTES}-byte request limit.`,
      { total },
    );
  }

  const client = options.clientFor(session.botId);
  if (!client)
    // `refuse` never resolves (audit first, then UploadLimitError); returning
    // it keeps that contract and narrows `client` for the sandbox writes.
    return refuse("Code execution is not configured on this deployment.", {
      configured: false,
    });

  const uploaded: Array<{ path: string; size: number }> = [];
  for (const file of files) {
    // A name from the wire never becomes a path: separators are flattened so one file cannot
    // climb out of the workspace with ../ or plant into another Bot's tree with a slash.
    const name = file.name.replace(/[/\\]/g, "_");
    const written = await client.writeFile(name, file.content);
    uploaded.push(written);
  }

  if (options.auditStore) {
    await recordAuditEvent(options.auditStore, {
      eventType: "workshop.file_uploaded",
      targetType: "workshop_session",
      targetId: sessionId,
      actorUserId: options.actorUserId,
      payload: {
        bot: session.botId,
        files: uploaded.map((file) => file.path),
        totalBytes: total,
      },
    });
  }
  await options.store.touchSession(sessionId);
  return { uploaded };
}
