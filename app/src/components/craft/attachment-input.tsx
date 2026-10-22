import { IconRefresh, IconX } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { type UploadResult, uploadFile } from "@/lib/craft/client";

/**
 * The composer's attachment half — onyx's UploadFilesContext cut to the craft surface's one
 * flow: pick files → upload each into the session's attachments directory → ride the next
 * send. One chip per file with the four-state machine (PENDING → UPLOADING → COMPLETED |
 * FAILED); a failed chip retries or removes, and the composer holds the send until every chip
 * has settled — a turn must never reference an attachment that never landed.
 */

export type AttachmentChipStatus =
  | "PENDING"
  | "UPLOADING"
  | "COMPLETED"
  | "FAILED";

export type AttachmentChip = {
  id: string;
  file: File;
  status: AttachmentChipStatus;
  /** The server's answer once COMPLETED (its filename may differ from the local name). */
  result?: UploadResult;
  error?: string;
};

const freshId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export type UseAttachments = {
  chips: AttachmentChip[];
  addFiles: (files: FileList | File[]) => void;
  removeChip: (id: string) => void;
  retryChip: (id: string) => void;
  clear: () => void;
  /** The attachments the next send carries (server-resolved name/path/mime). */
  readyAttachments: { name: string; path: string; mime_type: string }[];
  /** True while any chip is still in flight — the send button's disabled state. */
  busy: boolean;
};

/** Drive every added file through the upload, one state machine per chip. */
export function useAttachments(sessionId: string): UseAttachments {
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  // The upload submits under the scope in force (MT091 / Issue #134, AC3): an attachment
  // lands in the session the scope in force owns.
  const scope = useScopedCache();
  const pair = scope.status === "open" ? (scope.selection ?? {}) : undefined;

  const patch = useCallback((id: string, fields: Partial<AttachmentChip>) => {
    setChips((current) =>
      current.map((chip) => (chip.id === id ? { ...chip, ...fields } : chip)),
    );
  }, []);

  const run = useCallback(
    async (chip: AttachmentChip) => {
      if (!sessionId) return; // no session bound — the attach road is closed
      patch(chip.id, { status: "UPLOADING", error: undefined });
      try {
        const result = await uploadFile(sessionId, chip.file, pair);
        patch(chip.id, { status: "COMPLETED", result });
      } catch (error) {
        patch(chip.id, {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [sessionId, patch, pair],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files).map<AttachmentChip>((file) => ({
        id: freshId(),
        file,
        status: "PENDING",
      }));
      if (incoming.length === 0) return;
      setChips((current) => [...current, ...incoming]);
      for (const chip of incoming) void run(chip);
    },
    [run],
  );

  const removeChip = useCallback((id: string) => {
    setChips((current) => current.filter((chip) => chip.id !== id));
  }, []);

  const retryChip = useCallback(
    (id: string) => {
      const chip = chips.find((entry) => entry.id === id);
      if (chip) void run(chip);
    },
    [chips, run],
  );

  const clear = useCallback(() => setChips([]), []);

  const readyAttachments = chips
    .filter((chip) => chip.status === "COMPLETED" && chip.result)
    .map((chip) => ({
      name: chip.result?.filename ?? chip.file.name,
      path: chip.result?.path ?? "",
      mime_type: chip.file.type || "application/octet-stream",
    }));

  const busy = chips.some(
    (chip) => chip.status === "PENDING" || chip.status === "UPLOADING",
  );

  return {
    chips,
    addFiles,
    removeChip,
    retryChip,
    clear,
    readyAttachments,
    busy,
  };
}

/** The chip row: status at a glance, remove everywhere, retry where it failed. */
export function AttachmentTray({
  chips,
  onRemove,
  onRetry,
}: {
  chips: AttachmentChip[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const { t } = useTranslation("craft");
  if (chips.length === 0) return null;
  return (
    <ul
      className="flex flex-wrap gap-1.5 pb-2"
      aria-label={t("attachments.list")}
    >
      {chips.map((chip) => (
        <li
          key={chip.id}
          className="flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs"
          title={chip.error ?? chip.result?.path ?? chip.file.name}
        >
          <span className="max-w-48 truncate">
            {chip.result?.filename ?? chip.file.name}
          </span>
          {chip.status === "UPLOADING" || chip.status === "PENDING" ? (
            <span className="text-muted-foreground">
              {t("attachments.uploading")}
            </span>
          ) : null}
          {chip.status === "FAILED" ? (
            <>
              <span className="text-destructive">
                {t("attachments.failed")}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-4"
                aria-label={t("attachments.retry")}
                onClick={() => onRetry(chip.id)}
              >
                <IconRefresh className="size-3" />
              </Button>
            </>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            className="size-4"
            aria-label={t("attachments.remove")}
            onClick={() => onRemove(chip.id)}
          >
            <IconX className="size-3" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
