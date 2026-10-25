import { IconBrain, IconSchool } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  scopedPauseControlsQueryOptions,
  setPauseControlsMutationOptions,
} from "@/lib/memory";

/**
 * The person's two pause switches (#392): stop Bots learning new things, stop them using what
 * they already hold. Binary and immediate, so each row is a Switch with no save, and the row's
 * description states the consequence while it is on.
 *
 * Where the switches cannot answer, the rows stay greyed out with one sentence saying why: a
 * deployment that mounts no such face, and the personal context, which selects no company for
 * the switches to be keyed by. Neither is a fault to report.
 */
export function MemoryPauseControlsSection() {
  const { t } = useTranslation("agents");
  // Both halves ride the scope the screen holds, like every other memory call (MT089).
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const pauses = useQuery(scopedPauseControlsQueryOptions(queryClient, scope));
  const save = useMutation(setPauseControlsMutationOptions(queryClient, scope));
  // One narrowing read of the answer: `controls` present means the switches are mounted.
  const controls =
    pauses.data?.state === "mounted" ? pauses.data.controls : undefined;
  const mounted = controls !== undefined;
  let note: string | null = null;
  if (pauses.data?.state === "unmounted") note = t("memory.pause.unavailable");
  else if (pauses.data?.state === "no-company")
    note = t("memory.pause.noCompany");
  return (
    <PageSection
      description={t("memory.pause.description")}
      title={t("memory.pause.title")}
    >
      {pauses.isPending ? null : pauses.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {pauses.error.message}
        </p>
      ) : (
        <>
          <PageRows>
            <PauseRow
              description={t("memory.pause.learningHint")}
              disabled={!mounted || save.isPending}
              icon={<IconSchool />}
              label={t("memory.pause.learning")}
              paused={(controls?.learningPausedAt ?? null) !== null}
              onFlip={(on) => save.mutate({ learningPaused: on })}
            />
            <Separator />
            <PauseRow
              description={t("memory.pause.usageHint")}
              disabled={!mounted || save.isPending}
              icon={<IconBrain />}
              label={t("memory.pause.usage")}
              paused={(controls?.usagePausedAt ?? null) !== null}
              onFlip={(on) => save.mutate({ usagePaused: on })}
            >
              {/* Pause recall keeps what the person confirmed; the note says so while it is on. */}
              {(controls?.usagePausedAt ?? null) !== null ? (
                <ItemDescription className="line-clamp-none">
                  {t("memory.pause.usagePausedNote")}
                </ItemDescription>
              ) : null}
            </PauseRow>
          </PageRows>
          {note !== null ? (
            <p className="mt-4 text-muted-foreground text-sm">{note}</p>
          ) : null}
          {save.error ? (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {save.error.message}
            </p>
          ) : null}
        </>
      )}
    </PageSection>
  );
}

/** One switch row: an icon, the switch's name, its consequence, and the switch itself. */
function PauseRow({
  description,
  disabled,
  icon,
  label,
  paused,
  onFlip,
  children,
}: {
  description: string;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  paused: boolean;
  onFlip: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {description}
        </ItemDescription>
        {children}
      </ItemContent>
      <ItemActions>
        {/* Binary and immediate: Bots stop or start when switched, with no save. */}
        <Switch
          aria-label={label}
          checked={paused}
          disabled={disabled}
          onCheckedChange={onFlip}
        />
      </ItemActions>
    </Item>
  );
}
