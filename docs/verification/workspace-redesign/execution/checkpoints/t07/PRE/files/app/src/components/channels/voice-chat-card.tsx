import { IconChevronDown, IconLoader2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IconWaveform } from "@/components/icons/waveform";
import { Button } from "@/components/ui/button";
import {
  saveVoiceSession,
  type VoiceChatEntry,
  voiceSessionInput,
} from "@/lib/voice/archive";

export function VoiceChatCard({ call }: { call: VoiceChatEntry }) {
  const { t } = useTranslation("channels");
  const saving = call.saveState === "saving";
  const unsaved = call.saveState === "unsaved";
  const duration = `${Math.floor(call.durationSeconds / 60)
    .toString()
    .padStart(
      2,
      "0",
    )}:${(call.durationSeconds % 60).toString().padStart(2, "0")}`;
  return (
    <div className="rounded-xl bg-ob-muted-surface/60 px-3 py-2 text-sm">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <IconWaveform className="size-3.5" />
          <span className="flex-1 font-medium">{t("voiceCard.title")}</span>
          {saving && (
            <IconLoader2
              aria-label={t("voiceCard.savingAria")}
              className="size-3 motion-safe:animate-spin"
            />
          )}
          <span className="tabular-nums text-muted-foreground">{duration}</span>
          <IconChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="mt-3 max-h-72 space-y-3 overflow-y-auto border-t border-border pt-3">
          {call.transcript.map((entry) => (
            <div key={entry.id}>
              <p className="mb-0.5 text-xs font-medium text-muted-foreground">
                {entry.role === "user"
                  ? t("voiceCard.you")
                  : t("voiceCard.agent")}
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {entry.text}
              </p>
            </div>
          ))}
        </div>
      </details>
      <p className="mt-1 text-sm leading-snug" aria-live="polite">
        {call.summary ??
          (saving
            ? t("voiceCard.saving")
            : unsaved
              ? t("voiceCard.unsaved")
              : t("voiceCard.summaryFailed"))}
      </p>
      {(unsaved || (!saving && call.summaryStatus === "failed")) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {call.saveError ?? t("voiceCard.expandHint")}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => saveVoiceSession(voiceSessionInput(call))}
          >
            {unsaved ? t("voiceCard.retrySave") : t("voiceCard.retrySummary")}
          </Button>
        </div>
      )}
    </div>
  );
}
