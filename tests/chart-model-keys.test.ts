/**
 * The model credentials, rendered by real Helm from the real chart: an OpenAI key, an Anthropic key,
 * or both, and the provider, model and endpoint a deployment behind a model router names.
 *
 * What must not regress:
 *  - an Anthropic key given to the chart reaches the server as ANTHROPIC_API_KEY, from the same
 *    Secret and in the same way as the OpenAI key reaches it as OPENAI_API_KEY, so nobody has to
 *    hand-write `server.extraEnv` with a secretKeyRef;
 *  - with the operator's own Secret, the server reads `anthropic-api-key` from it, optionally,
 *    because a deployment on OpenAI alone has no such key and must still start;
 *  - an install on OpenAI alone names no provider, model or endpoint and writes no Anthropic key;
 *  - `config.model.name` reaches every workload that runs Bots as BOT_MODEL, and only when set.
 *  - every new value can be absent, as it is on a release upgraded with `--reuse-values`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm") !== null;
const chart = join(import.meta.dir, "../charts/openbot");

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string; optional?: boolean };
  };
};
type PodSpec = { containers: { name: string; env?: EnvVar[] }[] };
type Doc = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: {
    template?: { spec: PodSpec };
    jobTemplate?: { spec: { template: { spec: PodSpec } } };
  };
  stringData?: Record<string, string>;
};

/** The vanilla install the README gives, with whatever else is asked. */
function render(...args: string[]): Doc[] {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "openbot",
      chart,
      "--namespace",
      "openbot",
      "--values",
      join(chart, "ci/vanilla-values.yaml"),
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return parseAllDocuments(new TextDecoder().decode(result.stdout))
    .map((document) => document.toJSON() as Doc | null)
    .filter((document): document is Doc => document !== null);
}

const component = (name: string) => (doc: Doc) =>
  doc.metadata.labels?.["app.kubernetes.io/component"] === name;

function workloadEnv(docs: Doc[], kind: string, name: string): EnvVar[] {
  const doc = docs.find((d) => d.kind === kind && component(name)(d));
  if (!doc) throw new Error(`no ${name} ${kind} rendered`);
  const pod =
    doc.spec?.template?.spec ?? doc.spec?.jobTemplate?.spec.template.spec;
  return pod?.containers[0]?.env ?? [];
}

function serverEnv(docs: Doc[]): EnvVar[] {
  return workloadEnv(docs, "Deployment", "server");
}

function variable(docs: Doc[], name: string): EnvVar | undefined {
  return serverEnv(docs).find((e) => e.name === name);
}

function secret(docs: Doc[], name: string): Doc | undefined {
  return docs.find((d) => d.kind === "Secret" && d.metadata.name === name);
}

const ANTHROPIC_KEY = "the-customers-anthropic-key";
const OPENAI_KEY = "the-customers-openai-key";

describe.skipIf(!helm)("an Anthropic key", () => {
  test("is written to the chart's Secret and reaches the server as ANTHROPIC_API_KEY", () => {
    const docs = render(
      "--set-string",
      "secrets.modelApiKey=",
      "--set-string",
      `secrets.anthropicApiKey=${ANTHROPIC_KEY}`,
    );
    expect(
      secret(docs, "openbot-secrets")?.stringData?.["anthropic-api-key"],
    ).toBe(ANTHROPIC_KEY);
    expect(
      variable(docs, "ANTHROPIC_API_KEY")?.valueFrom?.secretKeyRef,
    ).toEqual({
      name: "openbot-secrets",
      key: "anthropic-api-key",
      optional: true,
    });
  });

  test("sits beside the OpenAI key, each under its own name", () => {
    const docs = render(
      "--set-string",
      `secrets.modelApiKey=${OPENAI_KEY}`,
      "--set-string",
      `secrets.anthropicApiKey=${ANTHROPIC_KEY}`,
    );
    const written = secret(docs, "openbot-secrets")?.stringData ?? {};
    expect(written["model-api-key"]).toBe(OPENAI_KEY);
    expect(written["anthropic-api-key"]).toBe(ANTHROPIC_KEY);
    expect(variable(docs, "OPENAI_API_KEY")?.valueFrom?.secretKeyRef?.key).toBe(
      "model-api-key",
    );
  });

  test("is read from the operator's own Secret as `anthropic-api-key`, optionally", () => {
    const docs = render(
      "--set-string",
      "secrets.existingSecret=mine",
      "--set-string",
      "postgresql.auth.existingSecret=mine",
    );
    expect(
      variable(docs, "ANTHROPIC_API_KEY")?.valueFrom?.secretKeyRef,
    ).toEqual({
      name: "mine",
      key: "anthropic-api-key",
      optional: true,
    });
    expect(secret(docs, "openbot-secrets")).toBeUndefined();
  });
});

describe.skipIf(!helm)("an install on OpenAI alone", () => {
  test("writes no Anthropic key and names no provider or endpoint", () => {
    const docs = render("--set-string", `secrets.modelApiKey=${OPENAI_KEY}`);
    const written = secret(docs, "openbot-secrets")?.stringData ?? {};
    expect(written["model-api-key"]).toBe(OPENAI_KEY);
    expect(written).not.toHaveProperty("anthropic-api-key");
    expect(variable(docs, "OPENAI_API_KEY")?.valueFrom?.secretKeyRef).toEqual({
      name: "openbot-secrets",
      key: "model-api-key",
      optional: true,
    });
    // An empty BOT_PROVIDER reads as OpenAI and overrides the tenant package's own provider, and a
    // set BOT_MODEL is the deployment's default model, so each must be absent rather than blank.
    for (const name of [
      "BOT_PROVIDER",
      "BOT_MODEL",
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
    ]) {
      expect(variable(docs, name)).toBeUndefined();
    }
  });
});

describe.skipIf(!helm)("the provider and endpoint, for a model router", () => {
  test("reach the server as BOT_PROVIDER, OPENAI_BASE_URL and ANTHROPIC_BASE_URL", () => {
    const docs = render(
      "--set-string",
      "config.model.provider=anthropic",
      "--set-string",
      "config.model.openaiBaseUrl=https://router.internal/openai/v1",
      "--set-string",
      "config.model.anthropicBaseUrl=https://router.internal/anthropic",
    );
    expect(variable(docs, "BOT_PROVIDER")?.value).toBe("anthropic");
    expect(variable(docs, "OPENAI_BASE_URL")?.value).toBe(
      "https://router.internal/openai/v1",
    );
    expect(variable(docs, "ANTHROPIC_BASE_URL")?.value).toBe(
      "https://router.internal/anthropic",
    );
  });

  test("render when absent, as on a release upgraded with --reuse-values", () => {
    const docs = render("--set", "config.model=null");
    expect(variable(docs, "BOT_PROVIDER")).toBeUndefined();
  });

  test("accept the provider in any case, as the server reads it", () => {
    const docs = render("--set-string", "config.model.provider=Anthropic");
    expect(variable(docs, "BOT_PROVIDER")?.value).toBe("Anthropic");
  });

  test("refuse a provider the server would silently ignore", () => {
    // The server reads only openai or anthropic and quietly falls back to the tenant package's
    // provider for anything else, so `claude` on an Anthropic-only install would fail every turn
    // with "set OPENAI_API_KEY" and nothing at install time would have said why.
    expect(() =>
      render("--set-string", "config.model.provider=claude"),
    ).toThrow(/config\.model\.provider/);
  });
});

describe.skipIf(!helm)("the model, for a model router", () => {
  test("reaches every workload that runs Bots as BOT_MODEL", () => {
    const docs = render(
      "--set-string",
      "config.model.provider=openai",
      "--set-string",
      "config.model.name=openai/gpt-5.5",
    );
    expect(variable(docs, "BOT_MODEL")?.value).toBe("openai/gpt-5.5");
    // The routines sweep runs Bots on the server's environment, so it names the same model.
    expect(
      workloadEnv(docs, "CronJob", "routines").find(
        (e) => e.name === "BOT_MODEL",
      )?.value,
    ).toBe("openai/gpt-5.5");
  });

  test("is absent unless named, so the provider's own default stands", () => {
    const docs = render("--set-string", "config.model.provider=anthropic");
    expect(variable(docs, "BOT_MODEL")).toBeUndefined();
    expect(
      workloadEnv(docs, "CronJob", "routines").find(
        (e) => e.name === "BOT_MODEL",
      ),
    ).toBeUndefined();
  });

  test("renders when the key is absent, as on a release upgraded with --reuse-values", () => {
    const docs = render("--set", "config.model.name=null");
    expect(variable(docs, "BOT_MODEL")).toBeUndefined();
  });
});
