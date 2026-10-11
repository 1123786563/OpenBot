import { IconPlayerStopFilled, IconSend } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The input bar: a growing textarea plus the one verb the moment allows — send while idle, stop
 * while the agent is mid-turn. Enter sends, Shift+Enter breaks, and the stop button is the single
 * control that halts a long build in place (onyx's composer).
 */
export function Composer({
  disabled = false,
  streaming = false,
  onSend,
  onInterrupt,
}: {
  disabled?: boolean;
  streaming?: boolean;
  onSend: (content: string) => void | Promise<void>;
  onInterrupt: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const content = draft.trim();
    if (!content || disabled || streaming || sending) return;
    setSending(true);
    setDraft("");
    if (ref.current) ref.current.style.height = "auto";
    try {
      await onSend(content);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-border p-3">
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
          disabled={disabled || !draft.trim() || sending}
          aria-label="Send"
          onClick={() => void submit()}
        >
          <IconSend />
        </Button>
      )}
    </div>
  );
}
