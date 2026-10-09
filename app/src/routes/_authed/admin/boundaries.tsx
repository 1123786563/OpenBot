import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isComposing } from "@/lib/composing";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  type DryRunReport,
  dryRunActionPolicy,
  type PolicyMode,
} from "@/lib/computers/queries";
import { useDateTime } from "@/lib/i18n/datetime";
import { queryClient } from "@/query-client";

/**
 * CEL computer-action boundary editor. Rules are shown as the gateway evaluates them, and denied
 * actions are recorded in Audit with the matching rule.
 */

/**
 * Presets are concrete CEL rules, not a separate policy language.
 */
const PRESETS = [
  {
    label: "boundaries.presets.noForms.label",
    // `key` is guarded by tool name so the clause short-circuits before it on actions that have no
    // keypress in them. Both tools that can press Enter are named: `computer_type` takes a `submit`
    // flag that presses it once the text is in, and a rule naming only `computer_key` left that door
    // open.
    rule: '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && key == "Enter")',
    cost: "boundaries.presets.noForms.cost",
  },
  {
    label: "boundaries.presets.noPasswords.label",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "boundaries.presets.noPasswords.cost",
  },
  {
    label: "boundaries.presets.socialMedia.label",
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    cost: "boundaries.presets.socialMedia.cost",
  },
] as const satisfies readonly { label: string; rule: string; cost?: string }[];

export const Route = createFileRoute("/_authed/admin/boundaries")({
  component: BoundariesPage,
});

function BoundariesPage() {
  const { t } = useTranslation("admin");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");

  const [tested, setTested] = useState<{
    rule: string;
    report: DryRunReport;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));

  /*
   * The saved policy wins while a save is in flight and after it lands: the server normalises what
   * it stores, so what came back is the policy, not what was sent.
   */
  const policy = savePolicy.data ?? stored.data ?? null;
  const saving = savePolicy.isPending;

  const save = (next: ActionPolicy) => {
    setSaved(false);
    setProblem(null);
    savePolicy.mutate(next, {
      onError: (thrown: Error) => setProblem(thrown.message),
      onSuccess: () => setSaved(true),
    });
  };

  /*
   * A read that failed says so. This screen used to set "The boundary could not be read." itself;
   * since the read became a query, that sentence (or the server's own) is the query's error, and
   * without this the page sat on its title with nothing under it for as long as it was open.
   */
  const unreadable = problem ?? stored.error?.message ?? null;
  if (unreadable && !policy) {
    return (
      <PageShell title={t("boundaries.title")}>
        <p className="mt-4 text-destructive text-sm" role="alert">
          {unreadable}
        </p>
      </PageShell>
    );
  }

  /* Nothing until the policy is known: a rule list that guesses is worse than a blank. */
  if (!policy) {
    return <PageShell title={t("boundaries.title")}>{null}</PageShell>;
  }

  const addRule = (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed || policy.deny.includes(trimmed)) return;
    void save({ ...policy, deny: [...policy.deny, trimmed] });
    setDraft("");
    setTested(null);
  };

  /*
   * The rule as it would be in force — the current policy plus this draft — replayed over recent
   * recorded actions. Nothing is saved and nothing is decided; the reply names the actions the
   * addition would have decided differently, so the rule's real reach is known before it starts
   * refusing anybody.
   */
  const testRule = async (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return;
    setProblem(null);
    setTesting(true);
    try {
      const report = await dryRunActionPolicy({
        ...policy,
        deny: [...policy.deny, trimmed],
      });
      setTested({ rule: trimmed, report });
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <PageShell
      description={
        <Trans
          components={{
            audit: <Link className="underline" to="/admin/audit" />,
          }}
          i18nKey="boundaries.description"
          t={t}
        />
      }
      title={t("boundaries.title")}
    >
      <PageSection
        description={t("boundaries.whenRuleMatches.description")}
        title={t("boundaries.whenRuleMatches.title")}
      >
        <div className="mt-2 flex gap-2">
          {(["enforce", "dry-run"] as PolicyMode[]).map((mode) => (
            <Button
              key={mode}
              aria-pressed={policy.mode === mode}
              className={policy.mode === mode ? "bg-foreground/5" : undefined}
              disabled={saving}
              onClick={() => void save({ ...policy, mode })}
              size="sm"
              variant="outline"
            >
              {mode === "enforce"
                ? t("boundaries.mode.enforce")
                : t("boundaries.mode.dryRun")}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {policy.mode === "enforce"
            ? t("boundaries.mode.enforceHint")
            : t("boundaries.mode.dryRunHint")}
        </p>
      </PageSection>

      <PageSection
        description={
          <Trans
            components={{ code: <code /> }}
            i18nKey="boundaries.never.description"
            t={t}
          />
        }
        title={t("boundaries.never.title")}
      >
        {policy.deny.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("boundaries.never.empty")}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {policy.deny.map((rule) => (
              <li
                className="flex items-center justify-between gap-4 px-3 py-2"
                key={rule}
              >
                <code className="min-w-0 break-all font-mono text-xs">
                  {rule}
                </code>
                <Button
                  disabled={saving}
                  onClick={() =>
                    void save({
                      ...policy,
                      deny: policy.deny.filter((one) => one !== rule),
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  {t("boundaries.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            aria-label={t("boundaries.ruleAria")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setTested(null);
            }}
            onKeyDown={(event) => {
              // Not the Enter that confirms a composed character, which would put a half-typed
              // rule into the policy in force.
              if (event.key === "Enter" && !isComposing(event)) addRule(draft);
            }}
            placeholder='tool.name == "computer_click" && contains(element.name, "submit")'
            value={draft}
          />
          <Button
            disabled={testing || draft.trim().length === 0}
            onClick={() => void testRule(draft)}
            size="sm"
            variant="outline"
          >
            {testing ? t("boundaries.testing") : t("boundaries.testFirst")}
          </Button>
          <Button
            disabled={saving || draft.trim().length === 0}
            onClick={() => addRule(draft)}
            size="sm"
          >
            {t("boundaries.addRule")}
          </Button>
        </div>

        {tested ? <DryRunResult report={tested.report} /> : null}

        <ul className="mt-3 space-y-2">
          {PRESETS.map((preset) => (
            <li className="flex items-start gap-3" key={preset.rule}>
              <Button
                className="shrink-0"
                disabled={saving || policy.deny.includes(preset.rule)}
                onClick={() => addRule(preset.rule)}
                size="sm"
                variant="outline"
              >
                {t(preset.label)}
              </Button>
              {preset.cost ? (
                <span className="pt-1 text-xs text-muted-foreground">
                  {t(preset.cost)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection
        description={t("boundaries.otherwise.description")}
        title={t("boundaries.otherwise.title")}
      >
        <ul className="mt-2 space-y-1">
          {policy.allow.map((rule) => (
            <li className="font-mono text-xs text-muted-foreground" key={rule}>
              {rule === "true" ? t("boundaries.otherwise.trueRule") : rule}
            </li>
          ))}
        </ul>
      </PageSection>

      <p className="mt-8 text-muted-foreground text-xs">
        {problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : saved ? (
          t("boundaries.savedNotice")
        ) : (
          t("boundaries.pendingNotice")
        )}
      </p>
    </PageShell>
  );
}

/**
 * What the tested rule would have done to actions already on the trail.
 *
 * Says the number over everything scanned first, because the list below it is capped and a reader
 * who stops at the rows should not believe the rows are the whole answer.
 */
function DryRunResult({ report }: { report: DryRunReport }) {
  const { t } = useTranslation("admin");
  const { formatDateTime } = useDateTime();
  if (report.scanned === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {t("boundaries.test.noneYet")}
      </p>
    );
  }

  return (
    <div className="mt-2" role="status">
      <p className="text-xs text-muted-foreground">
        {report.wouldRefuse === 0
          ? t("boundaries.test.refusedNone", { scanned: report.scanned })
          : t("boundaries.test.refusedSome", {
              scanned: report.scanned,
              wouldRefuse: report.wouldRefuse,
            })}
      </p>
      {report.changes.length > 0 ? (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {report.changes.map((change) => (
            <li className="px-3 py-2" key={change.id}>
              <p className="text-xs">
                <span className="font-medium">
                  {change.would === "refused"
                    ? t("boundaries.test.wouldRefuse")
                    : t("boundaries.test.wouldAllow")}
                </span>{" "}
                <code className="font-mono">{change.action}</code>
                {change.element?.name ? (
                  <> {t("boundaries.test.on", { name: change.element.name })}</>
                ) : null}
                {change.command ? (
                  <>
                    {" "}
                    {t("boundaries.test.running")}{" "}
                    <code className="font-mono">{change.command}</code>
                  </>
                ) : null}
                {change.file ? (
                  <> {t("boundaries.test.touching", { file: change.file })}</>
                ) : null}
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {change.bot}
                {change.page ? <> · {change.page}</> : null} ·{" "}
                {formatDateTime(change.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {report.wouldRefuse > report.changes.length ? (
        <p className="mt-1 text-muted-foreground text-xs">
          {t("boundaries.test.more", { shown: report.changes.length })}
        </p>
      ) : null}
    </div>
  );
}
