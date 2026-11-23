import { t } from "@/i18n";
import type { DesktopAiConnection } from "./queries";

/** One line of the AI model dialog: what it is, and this installation's answer. */
export type AiConnectionDetail = { label: string; value: string };

/** The AI connection in a person's words: who provides it, how OpenBot signs in, and the model. */
export type AiConnectionSummary = {
  provider: string;
  /** The row's second line: how OpenBot signs in, and the model when one was named. */
  summary: string;
  details: AiConnectionDetail[];
};

/**
 * The addresses the setup window fills in for a provider's own row (`endpointPresets` in
 * desktop/src/ProviderPicker.tsx), by host. Any other address is the person's own.
 */
const PRESET_HOSTS: Record<string, string> = {
  "generativelanguage.googleapis.com": "Google Gemini",
  "api.x.ai": "xAI",
  "api.unbiased.ai": "Unbiased AI",
};

/*
 * Provider names stay identity strings: they are the provider's own name, the same in every
 * language. The words around them are chosen here, at call time, in the language in force.
 */
function signedIn(
  kind: NonNullable<DesktopAiConnection["kind"]>,
  host: string | null,
): {
  provider: string;
  signIn: string;
  /** The `signIn` words are literally the address, so the dialog labels it Address. */
  signInIsHost: boolean;
  said: string;
} {
  switch (kind) {
    case "claude-plan":
      return {
        provider: "Anthropic",
        signIn: t("settings.ai.signIn.claudePlan", "Claude plan"),
        signInIsHost: false,
        said: t(
          "settings.ai.said.claudePlan",
          "Signed in with your Claude plan.",
        ),
      };
    case "chat-gpt-plan":
      return {
        provider: "OpenAI",
        signIn: t("settings.ai.signIn.chatGptPlan", "ChatGPT plan"),
        signInIsHost: false,
        said: t(
          "settings.ai.said.chatGptPlan",
          "Signed in with your ChatGPT plan.",
        ),
      };
    case "anthropic-api-key":
      return {
        provider: "Anthropic",
        signIn: t("settings.ai.signIn.apiKey", "API key"),
        signInIsHost: false,
        said: t(
          "settings.ai.said.anthropicApiKey",
          "Uses your Anthropic API key.",
        ),
      };
    case "open-ai-api-key":
      return {
        provider: "OpenAI",
        signIn: t("settings.ai.signIn.apiKey", "API key"),
        signInIsHost: false,
        said: t("settings.ai.said.openAiApiKey", "Uses your OpenAI API key."),
      };
    case "google-oauth":
      return {
        provider: "Google Gemini",
        signIn: t("settings.ai.signIn.googleAccount", "Google account"),
        signInIsHost: false,
        said: t(
          "settings.ai.said.googleAccount",
          "Signed in with your Google account.",
        ),
      };
    case "xai-oauth":
      return {
        provider: "xAI",
        signIn: t("settings.ai.signIn.xaiAccount", "xAI account"),
        signInIsHost: false,
        said: t(
          "settings.ai.said.xaiAccount",
          "Signed in with your xAI account.",
        ),
      };
    case "compatible-endpoint": {
      const preset = host ? PRESET_HOSTS[host] : undefined;
      if (preset)
        return {
          provider: preset,
          signIn: t("settings.ai.signIn.apiKey", "API key"),
          signInIsHost: false,
          said: t(
            "settings.ai.said.presetApiKey",
            "Uses your {provider} API key.",
            { provider: preset },
          ),
        };
      return {
        provider: "OpenAI-compatible",
        signIn: host ?? t("settings.ai.signIn.ownAddress", "Your own address"),
        // The words are an address either way, so the dialog labels it Address.
        signInIsHost: true,
        said: host
          ? t("settings.ai.said.connectedTo", "Connected to {host}.", { host })
          : t(
              "settings.ai.said.connectedToOwn",
              "Connected to your own address.",
            ),
      };
    }
  }
}

/** What Settings says about the AI connection; null when none has been chosen yet. */
export function describeAiConnection(
  connection: DesktopAiConnection,
): AiConnectionSummary | null {
  if (!connection.kind) return null;
  const { provider, signIn, signInIsHost, said } = signedIn(
    connection.kind,
    connection.endpointHost,
  );
  const details: AiConnectionDetail[] = [
    { label: t("settings.ai.detailProvider", "Provider"), value: provider },
    {
      label:
        connection.kind === "compatible-endpoint" && signInIsHost
          ? t("settings.ai.detailAddress", "Address")
          : t("settings.ai.detailSignIn", "Sign-in"),
      value: signIn,
    },
  ];
  if (connection.model)
    details.push({
      label: t("settings.ai.detailModel", "Model"),
      value: connection.model,
    });
  return {
    provider,
    summary: connection.model
      ? t("settings.ai.summaryWithModel", "{said} Model: {model}", {
          said,
          model: connection.model,
        })
      : said,
    details,
  };
}
