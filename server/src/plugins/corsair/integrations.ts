import { readFileSync } from "node:fs";
import { z } from "zod";

const authType = z.enum(["api_key", "oauth_2"]);

export const corsairIntegration = z.object({
  id: z.string().regex(/^[a-z0-9]+$/),
  displayName: z.string().min(1),
  description: z.string(),
  npmPackageName: z.string().regex(/^@corsair-dev\//),
  authTypes: z.array(authType),
  defaultAuthType: z.enum(["api_key", "oauth_2", "bot_token"]).nullable(),
  counts: z.object({
    api: z.number().int().nonnegative(),
    webhooks: z.number().int().nonnegative(),
    db: z.number().int().nonnegative(),
  }),
});

const catalogFile = z.object({
  catalogVersion: z.number().int(),
  corsairVersion: z.string(),
  generatedAt: z.string(),
  plugins: z.array(corsairIntegration),
});

export type CorsairIntegration = z.infer<typeof corsairIntegration>;

export type CorsairIntegrationStatus = CorsairIntegration & {
  credentialConfigured: boolean;
  oauthClientConfigured: boolean;
  validationSkipped: true;
};

let cached: z.infer<typeof catalogFile> | null = null;

export function corsairCatalog() {
  // shortcut: vendored from upstream corsairdev/corsair explorer catalog; regenerate when upgrading
  if (!cached) {
    cached = catalogFile.parse(
      JSON.parse(
        readFileSync(
          new URL("./integrations-catalog.generated.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  return cached;
}

function envKey(integrationId: string, suffix: string) {
  return `CORSAIR_${integrationId.toUpperCase()}_${suffix}`;
}

export function corsairIntegrationStatus(
  integration: CorsairIntegration,
  environment: Record<string, string | undefined>,
): CorsairIntegrationStatus {
  const apiKey = environment[envKey(integration.id, "API_KEY")]?.trim();
  const clientId = environment[envKey(integration.id, "CLIENT_ID")]?.trim();
  const clientSecret =
    environment[envKey(integration.id, "CLIENT_SECRET")]?.trim();
  return {
    ...integration,
    credentialConfigured: Boolean(apiKey),
    // informational only — the app-level integration deliberately skips client credential validation
    oauthClientConfigured: Boolean(clientId && clientSecret),
    validationSkipped: true,
  };
}

export function corsairIntegrations(
  environment: Record<string, string | undefined>,
) {
  return corsairCatalog().plugins.map((integration) =>
    corsairIntegrationStatus(integration, environment),
  );
}

export function findCorsairIntegration(integrationId: string) {
  return corsairCatalog().plugins.find(
    (integration) => integration.id === integrationId,
  );
}
