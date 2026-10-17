import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type enAdmin from "@/locales/en/admin.json";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  runGatewayProbeMutationOptions,
  saveGatewayCredentialMutationOptions,
  saveGatewayEndpointMutationOptions,
  saveGatewayRateMutationOptions,
} from "@/lib/gateway/mutations";
import {
  type GatewayAdminStatus,
  gatewayStatusQueryOptions,
} from "@/lib/gateway/queries";

export const Route = createFileRoute("/_authed/admin/gateway")({
  component: GatewayPage,
});

/**
 * The Bifrost gateway screen (Bifrost #214, 01.8): the one place an
 * administrator configures the model gateway and reads whether paid model
 * capabilities may be enabled at all.
 *
 * THE SERVER HOLDS THE VERDICT. This page draws every judgment from the
 * status answer — readiness, its blocking reasons, the configVersion, the
 * rate, the credential's fingerprint — and never computes a verdict of its
 * own. A not-ready gateway names every blocking reason, because an
 * administrator fixing four of five problems must not rediscover the fifth by
 * trial and error.
 *
 * NO PLAINTEXT, EVER. The credential field is write-only by construction: a
 * key is sent once to the credential route and the field is emptied; what
 * comes back — on this page and on every response — is the fingerprint, never
 * the key. The address and rate are configuration, not secrets, and are shown
 * as saved.
 */

/** The address refusals, keyed the way {@link baseUrlProblem} names them. */
const ADDRESS_PROBLEM_KEYS = {
  required: "gateway.fields.baseUrlProblem.required",
  invalid: "gateway.fields.baseUrlProblem.invalid",
  originOnly: "gateway.fields.baseUrlProblem.originOnly",
} as const;

/** The shape a section's error line needs from a mutation, decoupled from react-query's generics. */
type FieldProblem = { message: string };

/** The address rules 01.1 enforces server-side, checked here for fast feedback. */
function baseUrlProblem(raw: string): FieldProblem | undefined {
  const value = raw.trim();
  if (!value) {
    return { message: "required" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { message: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { message: "invalid" };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "" || parsed.search || parsed.hash || parsed.username) {
    return { message: "originOnly" };
  }
  return undefined;
}

function GatewayPage() {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const status = useQuery(gatewayStatusQueryOptions());
  const saveEndpoint = useMutation(
    saveGatewayEndpointMutationOptions(queryClient),
  );
  const saveRate = useMutation(saveGatewayRateMutationOptions(queryClient));
  const saveCredential = useMutation(
    saveGatewayCredentialMutationOptions(queryClient),
  );
  const runProbe = useMutation(runGatewayProbeMutationOptions(queryClient));

  const [baseUrl, setBaseUrl] = useState("");
  const [requestTimeoutMs, setRequestTimeoutMs] = useState("10000");
  const [endpointProblems, setEndpointProblems] = useState<FieldProblem[]>([]);
  const [numerator, setNumerator] = useState("");
  const [denominator, setDenominator] = useState("1");
  const [rateProblems, setRateProblems] = useState<FieldProblem[]>([]);
  const [adminKey, setAdminKey] = useState("");
  const [credentialProblem, setCredentialProblem] = useState<
    FieldProblem | undefined
  >(undefined);

  const submitEndpoint = () => {
    const timeout = Number(requestTimeoutMs);
    const problems: FieldProblem[] = [];
    const addressProblem = baseUrlProblem(baseUrl);
    if (addressProblem) {
      // The three refusal sentences are spelled out so the i18next typed keys
      // accept them; an unknown problem falls back to the generic invalid one.
      problems.push({
        message: t(
          ADDRESS_PROBLEM_KEYS[
            addressProblem.message as keyof typeof ADDRESS_PROBLEM_KEYS
          ] ?? "gateway.fields.baseUrlProblem.invalid",
        ),
      });
    }
    if (!Number.isInteger(timeout) || timeout <= 0) {
      problems.push({ message: t("gateway.fields.timeoutProblem") });
    }
    setEndpointProblems(problems);
    if (problems.length > 0) return;
    saveEndpoint.mutate(
      { baseUrl: baseUrl.trim(), requestTimeoutMs: timeout },
      { onSuccess: () => setBaseUrl("") },
    );
  };

  const submitRate = () => {
    const problems: FieldProblem[] = [];
    for (const [name, value] of [
      ["numerator", numerator],
      ["denominator", denominator],
    ] as const) {
      if (!/^\d+$/.test(value.trim()) || BigInt(value.trim() || "0") <= 0n) {
        problems.push({ message: t(`gateway.fields.${name}Problem`) });
      }
    }
    setRateProblems(problems);
    if (problems.length > 0) return;
    saveRate.mutate(
      { numerator: numerator.trim(), denominator: denominator.trim() },
      {
        onSuccess: () => {
          setNumerator("");
          setDenominator("1");
        },
      },
    );
  };

  const submitCredential = () => {
    if (!adminKey.trim()) {
      setCredentialProblem({ message: t("gateway.fields.adminKeyProblem") });
      return;
    }
    setCredentialProblem(undefined);
    // Sent once; the field empties on success, and the answer is a
    // fingerprint — the page never holds the plaintext after the send.
    saveCredential.mutate(
      { adminKey: adminKey.trim() },
      { onSuccess: () => setAdminKey("") },
    );
  };

  return (
    <PageShell
      title={t("gateway.title")}
      description={t("gateway.description")}
    >
      <PageSection
        title={t("gateway.readiness.title")}
        description={t("gateway.readiness.description")}
        action={
          <Button
            disabled={runProbe.isPending || status.isPending}
            onClick={() => runProbe.mutate()}
            size="sm"
            variant="outline"
          >
            {runProbe.isPending
              ? t("gateway.readiness.probing")
              : t("gateway.readiness.probe")}
          </Button>
        }
      >
        {status.isPending ? (
          <PageRowsSkeleton />
        ) : status.error ? (
          <p className="text-destructive text-sm" role="alert">
            {t("gateway.loadError")}
          </p>
        ) : (
          <ReadinessView status={status.data} probeError={runProbe.error} />
        )}
      </PageSection>

      <PageSection
        title={t("gateway.endpoint.title")}
        description={t("gateway.endpoint.description")}
      >
        <div className="flex flex-col gap-4">
          <Field data-invalid={endpointProblems.length > 0 || undefined}>
            <FieldLabel htmlFor="gateway-base-url">
              {t("gateway.fields.baseUrl")}
            </FieldLabel>
            <Input
              autoComplete="off"
              id="gateway-base-url"
              name="gateway-base-url"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://bifrost.internal"
              value={baseUrl}
            />
            {endpointProblems.length > 0 ? (
              <FieldError errors={endpointProblems} />
            ) : null}
          </Field>
          <Field data-invalid={endpointProblems.length > 0 || undefined}>
            <FieldLabel htmlFor="gateway-timeout">
              {t("gateway.fields.requestTimeoutMs")}
            </FieldLabel>
            <Input
              autoComplete="off"
              id="gateway-timeout"
              inputMode="numeric"
              name="gateway-timeout"
              onChange={(event) => setRequestTimeoutMs(event.target.value)}
              value={requestTimeoutMs}
            />
            {endpointProblems.length > 0 ? (
              <FieldError errors={endpointProblems} />
            ) : null}
          </Field>
          <div className="flex items-center gap-3">
            <Button
              disabled={saveEndpoint.isPending}
              onClick={submitEndpoint}
              size="sm"
            >
              {saveEndpoint.isPending
                ? t("gateway.saving")
                : t("gateway.endpoint.save")}
            </Button>
            {saveEndpoint.error ? (
              <p className="text-destructive text-sm" role="alert">
                {saveEndpoint.error.message}
              </p>
            ) : null}
          </div>
          {status.data?.endpoint ? (
            <p className="text-muted-foreground text-sm">
              <span data-testid="gateway-endpoint-saved">
                {status.data.endpoint.baseUrl} ·{" "}
                {t("gateway.fields.requestTimeoutMs")}{" "}
                {status.data.endpoint.requestTimeoutMs}ms
              </span>
            </p>
          ) : null}
        </div>
      </PageSection>

      <PageSection
        title={t("gateway.rate.title")}
        description={t("gateway.rate.description")}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 md:flex-row">
            <Field data-invalid={rateProblems.length > 0 || undefined}>
              <FieldLabel htmlFor="gateway-rate-numerator">
                {t("gateway.fields.numerator")}
              </FieldLabel>
              <Input
                autoComplete="off"
                id="gateway-rate-numerator"
                inputMode="numeric"
                name="gateway-rate-numerator"
                onChange={(event) => setNumerator(event.target.value)}
                value={numerator}
              />
            </Field>
            <Field data-invalid={rateProblems.length > 0 || undefined}>
              <FieldLabel htmlFor="gateway-rate-denominator">
                {t("gateway.fields.denominator")}
              </FieldLabel>
              <Input
                autoComplete="off"
                id="gateway-rate-denominator"
                inputMode="numeric"
                name="gateway-rate-denominator"
                onChange={(event) => setDenominator(event.target.value)}
                value={denominator}
              />
            </Field>
          </div>
          {rateProblems.length > 0 ? (
            <FieldError errors={rateProblems} />
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              disabled={saveRate.isPending}
              onClick={submitRate}
              size="sm"
            >
              {saveRate.isPending
                ? t("gateway.saving")
                : t("gateway.rate.save")}
            </Button>
            {saveRate.error ? (
              <p className="text-destructive text-sm" role="alert">
                {saveRate.error.message}
              </p>
            ) : null}
          </div>
          {status.data?.rate.configured ? (
            <p className="text-muted-foreground text-sm">
              <span data-testid="gateway-rate-current">
                {status.data.rate.numerator} / {status.data.rate.denominator} ·{" "}
                {t("gateway.rate.version")} {status.data.rate.rateVersion}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("gateway.rate.notConfigured")}
            </p>
          )}
        </div>
      </PageSection>

      <PageSection
        title={t("gateway.credential.title")}
        description={t("gateway.credential.description")}
      >
        <div className="flex flex-col gap-4">
          <Field data-invalid={credentialProblem !== undefined || undefined}>
            <FieldLabel htmlFor="gateway-admin-key">
              {t("gateway.fields.adminKey")}
            </FieldLabel>
            <Input
              autoComplete="new-password"
              id="gateway-admin-key"
              name="gateway-admin-key"
              onChange={(event) => setAdminKey(event.target.value)}
              type="password"
              value={adminKey}
            />
            {credentialProblem ? (
              <FieldError errors={[credentialProblem]} />
            ) : null}
          </Field>
          <div className="flex items-center gap-3">
            <Button
              disabled={saveCredential.isPending}
              onClick={submitCredential}
              size="sm"
            >
              {saveCredential.isPending
                ? t("gateway.saving")
                : t("gateway.credential.save")}
            </Button>
            {saveCredential.error ? (
              <p className="text-destructive text-sm" role="alert">
                {saveCredential.error.message}
              </p>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm">
            <span data-testid="gateway-credential-status">
              {status.data?.credential?.state === "configured"
                ? `${t("gateway.credential.configured")} · ${status.data.credential.fingerprint}`
                : t("gateway.credential.unconfigured")}
            </span>
          </p>
        </div>
      </PageSection>
    </PageShell>
  );
}

function ReadinessView({
  status,
  probeError,
}: {
  status: GatewayAdminStatus | undefined;
  probeError: Error | null;
}) {
  const { t } = useTranslation("admin");
  if (!status) return null;
  return (
    <PageRows>
      <Item size="sm">
        <ItemContent>
          <ItemTitle>
            {status.readiness.ready ? (
              <span data-testid="gateway-ready" className="text-emerald-600">
                {t("gateway.readiness.ready")}
              </span>
            ) : (
              <span className="text-destructive">
                {t("gateway.readiness.notReady")}
              </span>
            )}{" "}
            · {t("gateway.readiness.configVersion")}{" "}
            <span data-testid="gateway-config-version">
              {status.readiness.configVersion}
            </span>
          </ItemTitle>
          <ItemDescription>
            {status.probe
              ? t("gateway.probe.last", {
                  status: status.probe.status,
                  reasonCode: status.probe.reasonCode,
                })
              : t("gateway.probe.none")}
            {" · "}
            <span data-testid="gateway-probe-status">
              {status.probe ? status.probe.status : ""}
            </span>
          </ItemDescription>
          <ItemDescription>
            {status.extension
              ? t("gateway.extension.verdict", {
                  verdict: status.extension.creditAdmissionExtension,
                  version: status.extension.extensionVersion ?? "—",
                })
              : t("gateway.extension.none")}
            {" · "}
            <span data-testid="gateway-extension-status">
              {status.extension
                ? status.extension.creditAdmissionExtension
                : ""}
            </span>
          </ItemDescription>
        </ItemContent>
      </Item>
      {probeError ? (
        <p className="text-destructive text-sm" role="alert">
          {probeError.message}
        </p>
      ) : null}
      {!status.readiness.ready ? (
        <div data-testid="gateway-blocking-reasons">
          <p className="text-sm">{t("gateway.readiness.blockedIntro")}</p>
          <ul className="flex list-disc flex-col gap-1 ml-4">
            {status.readiness.blockingReasons.map((reason) => (
              <li className="text-sm" key={reason}>
                {reasonText(t, reason)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Separator />
    </PageRows>
  );
}

/**
 * Every reason the gate can name, keyed as the readiness service spells it. The
 * values are the locale's own key type (the en bundle is the source of truth,
 * as i18next.d.ts declares), so a sentence missing from the bundle is a type
 * error here rather than an empty bullet at runtime. A reason code a future
 * server adds before this page learns it falls back to the code itself — the
 * sentence may be missing, the information may not.
 */
const GATEWAY_REASON_CODES = {
  gateway_readiness_endpoint_not_configured:
    "gateway_readiness_endpoint_not_configured",
  gateway_readiness_endpoint_unavailable:
    "gateway_readiness_endpoint_unavailable",
  gateway_readiness_credential_not_configured:
    "gateway_readiness_credential_not_configured",
  gateway_readiness_credential_unavailable:
    "gateway_readiness_credential_unavailable",
  gateway_readiness_probe_missing: "gateway_readiness_probe_missing",
  gateway_readiness_probe_not_ok: "gateway_readiness_probe_not_ok",
  gateway_readiness_probe_unavailable: "gateway_readiness_probe_unavailable",
  gateway_readiness_extension_not_negotiated:
    "gateway_readiness_extension_not_negotiated",
  gateway_readiness_extension_absent: "gateway_readiness_extension_absent",
  gateway_readiness_extension_incompatible:
    "gateway_readiness_extension_incompatible",
  gateway_readiness_extension_unavailable:
    "gateway_readiness_extension_unavailable",
  gateway_readiness_rate_not_configured:
    "gateway_readiness_rate_not_configured",
  gateway_readiness_rate_unavailable: "gateway_readiness_rate_unavailable",
  gateway_readiness_gate_unavailable: "gateway_readiness_gate_unavailable",
} as const satisfies Record<string, keyof typeof enAdmin.gateway.blocking>;

/** The page's own `t`, so the blocking-reason helper speaks the admin namespace. */
type Translate = ReturnType<typeof useTranslation<"admin">>["t"];

function reasonText(t: Translate, reason: string): string {
  const code =
    GATEWAY_REASON_CODES[reason as keyof typeof GATEWAY_REASON_CODES];
  // The template literal over the code union is exactly the keys the bundle
  // declares, so this call is checked, not cast past the key typing.
  return code ? t(`gateway.blocking.${code}`) : reason;
}
