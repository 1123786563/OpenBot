import {
  IconPaperclip,
  IconPlayerStopFilled,
  IconSend,
} from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { CraftAttachment } from "@/lib/craft/types";
import { AttachmentTray, useAttachments } from "./attachment-input";

/**
 * The input bar: a growing textarea plus the one verb the moment allows — send while idle, stop
 * while the agent is mid-turn (onyx's composer) — and, when a session is bound, the "+" attach
 * road: pick files, watch each chip upload, send once every chip has settled. The send stays
 * disabled while any attachment is PENDING/UPLOADING, so a turn never references a file that
 * failed to land.
 */
export function Composer({
  sessionId,
  disabled = false,
  streaming = false,
  onSend,
  onInterrupt,
}: {
  /** The session uploads land in; absent disables the attach road (no session, no upload). */
  sessionId?: string;
  disabled?: boolean;
  streaming?: boolean;
  onSend: (
    content: string,
    attachments?: CraftAttachment[],
  ) => void | Promise<void>;
  onInterrupt: () => void | Promise<void>;
}) {
  const { t } = useTranslation("craft");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(sessionId ?? "");

  const submit = async () => {
    const content = draft.trim();
    const ready = attachments.readyAttachments;
    // The server requires non-empty content (onyx's MessageRequest), so a character is
    // always required — attachments ride alongside, never instead.
    if (!content || disabled || streaming || sending) return;
    if (attachments.busy) return; // a chip still in flight
    setSending(true);
    setDraft("");
    if (ref.current) ref.current.style.height = "auto";
    try {
      await onSend(content, ready.length > 0 ? ready : undefined);
      attachments.clear();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-border p-3">
      <AttachmentTray
        chips={attachments.chips}
        onRemove={attachments.removeChip}
        onRetry={attachments.retryChip}
      />
      <div className="flex items-end gap-2">
        {sessionId ? (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files)
                  attachments.addFiles(event.target.files);
                // Reset so picking the same file again after a remove still fires onChange.
                event.target.value = "";
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("attachments.add")}
              disabled={disabled || streaming}
              onClick={() => fileRef.current?.click()}
            >
              <IconPaperclip />
            </Button>
          </>
        ) : null}
        <textarea
          ref={ref}
          value={draft}
          disabled={disabled}
          rows={1}
          placeholder="What should your agent build?"
          className="max-h-40 min-h-9 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) => {
            setDraft(event.target.value);
            const el = event.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {streaming ? (
          <Button
            size="icon"
            variant="outline"
            aria-label="Stop"
            onClick={() => void onInterrupt()}
          >
            <IconPlayerStopFilled />
          </Button>
        ) : (
          <Button
            size="icon"
            disabled={disabled || !draft.trim() || sending || attachments.busy}
            aria-label="Send"
            onClick={() => void submit()}
          >
            <IconSend />
          </Button>
        )}
      </div>
    </div>
  );
}
