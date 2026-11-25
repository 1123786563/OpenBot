import type { Attachment } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { attachmentUrl } from "./attachments";

const startPrefix = "openbot:conversation-start:";
const uploadedReference = z.object({
  attachmentId: z.string().min(1),
  name: z.string(),
  mimeType: z.string().optional(),
  type: z.enum(["image", "document"]),
});
const recipient = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("route"), fallbackId: z.string().optional() }),
  z.object({ kind: z.literal("direct"), agentId: z.string() }),
  z.object({
    kind: z.literal("group"),
    agentIds: z.array(z.string()).min(2),
    addressedAgentId: z.string().nullable(),
  }),
]);
const progress = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("creating") }),
  z.object({ phase: z.literal("ready"), channelId: z.string() }),
  z.object({ phase: z.literal("submitted"), channelId: z.string() }),
]);
const payload = z.object({
  text: z.string(),
  commandIds: z.array(z.string()),
  attachments: z.array(uploadedReference),
  recipient,
  model: z
    .object({ model: z.string().nullable(), effort: z.string().nullable() })
    .nullable()
    .default(null),
});
const record = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), draft: payload, progress }),
  z.object({
    state: z.literal("finished"),
    channelId: z.string(),
    group: z.boolean(),
  }),
]);
export type StartDraft = z.infer<typeof payload>;
export type StartRecipient = StartDraft["recipient"];
export type StartRecord = z.infer<typeof record>;
export type PendingStart = Extract<StartRecord, { state: "pending" }>;

function ownerPrefix(owner: string) {
  return `${startPrefix}${encodeURIComponent(owner)}:`;
}

export function readPendingStart(
  owner: string,
  id: string,
): StartRecord | null {
  try {
    const saved = localStorage.getItem(ownerPrefix(owner) + id);
    if (saved === null) return null;
    const parsed = record.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function savePendingStart(
  owner: string,
  id: string,
  start: StartRecord,
) {
  try {
    localStorage.setItem(ownerPrefix(owner) + id, JSON.stringify(start));
  } catch {
    throw new Error(
      "This browser couldn't save your message. Check that site storage is available and try again.",
    );
  }
}

export function finishPendingStart(
  owner: string,
  id: string,
  channelId: string,
  group: boolean,
) {
  savePendingStart(owner, id, { state: "finished", channelId, group });
}

/** Remove an abandoned start so its text and attachment refs stop being recoverable. */
export function discardPendingStart(owner: string, id: string) {
  localStorage.removeItem(ownerPrefix(owner) + id);
}

export function pendingStartsFor(owner: string) {
  const pending: { id: string; start: PendingStart }[] = [];
  try {
    const prefix = ownerPrefix(owner);
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const start = readPendingStart(owner, id);
      if (start?.state === "pending") pending.push({ id, start });
    }
  } catch {
    return pending;
  }
  return pending;
}

export function findFirstMessage(owner: string, channelId: string) {
  return (
    pendingStartsFor(owner).find(
      ({ start }) =>
        start.draft.recipient.kind === "direct" &&
        start.progress.phase !== "creating" &&
        start.progress.channelId === channelId,
    ) ?? null
  );
}

export function pendingAttachmentRefs(
  attachments: readonly Attachment[],
): StartDraft["attachments"] {
  return attachments.map((attachment) => {
    const metadata = attachment.metadata;
    const parsed = uploadedReference.safeParse({
      attachmentId:
        metadata && typeof metadata === "object" && "attachmentId" in metadata
          ? metadata.attachmentId
          : undefined,
      name: attachment.filename ?? "Attachment",
      mimeType:
        attachment.source.type === "url"
          ? attachment.source.mimeType
          : undefined,
      type: attachment.type,
    });
    if (attachment.status !== "ready" || !parsed.success)
      throw new Error(
        "Wait for your attachments to finish uploading, then try again.",
      );
    return parsed.data;
  });
}

export function restorePendingAttachments(draft: StartDraft): Attachment[] {
  return draft.attachments.map(({ attachmentId, name, mimeType, type }) => ({
    id: attachmentId,
    filename: name,
    type,
    status: "ready",
    source: { type: "url", value: attachmentUrl(attachmentId), mimeType },
    metadata: { attachmentId, filename: name },
  }));
}

/** A durable, atomic claim keeps dated or concurrent tabs from starting a second direct run. */
export function claimFirstSend(owner: string, id: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("openbot-conversation-start", 1);
    const unavailable = () =>
      reject(
        new Error(
          "This browser couldn't save the first-message status. Try again.",
        ),
      );
    open.onerror = unavailable;
    open.onblocked = unavailable;
    open.onupgradeneeded = () => open.result.createObjectStore("send-claims");
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("send-claims", "readwrite");
      const claims = transaction.objectStore("send-claims");
      const key = JSON.stringify([owner, id]);
      const read = claims.getKey(key);
      let claimed = false;
      read.onsuccess = () => {
        if (read.result !== undefined) return;
        claims.add(true, key);
        claimed = true;
      };
      transaction.onabort = () => {
        database.close();
        unavailable();
      };
      transaction.oncomplete = () => {
        database.close();
        resolve(claimed);
      };
    };
  });
}
