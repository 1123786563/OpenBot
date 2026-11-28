import { Link, Redirect, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Switch, Text, View } from "react-native";
import { ApiError, everyPage, ORGANIZATION_ID } from "../src/api";
import {
  deleteBotGrant,
  listBotGrants,
  replaceBotGrant,
} from "../src/api/generated/bot-grants/bot-grants";
import { listSkills } from "../src/api/generated/skills/skills";
import { authClient } from "../src/auth";
import {
  isLocalMobilePreview,
  previewSkills,
  previewTools,
} from "../src/home-preview";
import {
  card,
  heading,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

/** What a Bot can use: skills switched on and off here, connected tools listed. */
export default function PluginsScreen() {
  const { botId = "", preview } = useLocalSearchParams<{
    botId: string;
    preview?: string;
  }>();
  if (isLocalMobilePreview("/plugins", preview)) {
    return <PluginsDetail botId={botId} sample />;
  }
  return <ConnectedPlugins botId={botId} />;
}

function ConnectedPlugins({ botId }: { botId: string }) {
  const { data: session, isPending } = authClient.useSession();
  return (
    <PluginsDetail botId={botId} session={session} isPending={isPending} />
  );
}

function PluginsDetail({
  botId,
  sample = false,
  session,
  isPending = false,
}: {
  botId: string;
  sample?: boolean;
  session?: ReturnType<typeof authClient.useSession>["data"];
  isPending?: boolean;
}) {
  const action = useAction();
  const loadGranted = useCallback(async () => {
    const grants = await everyPage(
      (page) => listBotGrants(ORGANIZATION_ID, botId, page),
      (page) => page.grants,
    );
    return {
      tools: grants.flatMap((grant) =>
        grant.kind === "action" && grant.action
          ? [{ ref: grant.ref, description: grant.action.description }]
          : [],
      ),
      skills: grants.flatMap((grant) =>
        grant.kind === "skill" && grant.skill ? [grant.skill] : [],
      ),
    };
  }, [botId]);
  const granted = useLoad(loadGranted, Boolean(session && botId));
  // Every skill this person can see, page after page.
  const loadCatalogue = useCallback(
    async () => ({
      skills: await everyPage(
        (page) => listSkills(ORGANIZATION_ID, page),
        (page) => page.skills,
      ),
    }),
    [],
  );
  const catalogue = useLoad(loadCatalogue, Boolean(session));
  if (!sample && !session && !isPending) return <Redirect href="/" />;
  const skills = sample ? previewSkills : catalogue.data?.skills;
  const tools = sample ? previewTools : granted.data?.tools;
  const on = new Set(
    sample
      ? ["weekly-planning"]
      : granted.data?.skills.map((skill) => skill.slug),
  );

  const setSkill = (slug: string, enabled: boolean) =>
    action.run(slug, async () => {
      const grantId = `skill:${slug}`;
      if (enabled) await replaceBotGrant(ORGANIZATION_ID, botId, grantId, {});
      else
        try {
          await deleteBotGrant(ORGANIZATION_ID, botId, grantId);
        } catch (error) {
          // A Bot that doesn't have the skill is already without it.
          if (
            !(error instanceof ApiError && error.code === "BOT_GRANT_NOT_FOUND")
          )
            throw error;
        }
      await granted.refresh();
    });

  return (
    <Screen
      refreshing={granted.pending || catalogue.pending}
      onRefresh={
        sample
          ? undefined
          : () => {
              void granted.refresh();
              void catalogue.refresh();
            }
      }
    >
      {sample && (
        <Link href={{ pathname: "/bot", params: { botId, preview: "1" } }}>
          Back to preview Bot
        </Link>
      )}
      <Text style={heading}>Plugins</Text>
      <Problem message={action.error || granted.error || catalogue.error} />
      <Section title="Skills">
        {skills?.length === 0 && <Text style={muted}>No skills yet.</Text>}
        {skills?.map((skill) => (
          <View
            key={skill.slug}
            style={[
              card,
              { flexDirection: "row", alignItems: "center", gap: 12 },
            ]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ fontWeight: "600" }}>
                {skill.title} (/{skill.slug})
              </Text>
              <Text style={muted}>{skill.summary}</Text>
            </View>
            <Switch
              accessibilityLabel={`Use ${skill.title}`}
              value={on.has(skill.slug)}
              disabled={sample || Boolean(action.busy) || !granted.data}
              onValueChange={(enabled) => {
                void setSkill(skill.slug, enabled);
              }}
            />
          </View>
        ))}
      </Section>
      <Section title="Connected tools">
        <Text style={muted}>
          Connecting an app needs its sign-in, so add and remove tools in
          OpenBot on your computer.
        </Text>
        {tools?.length === 0 && <Text style={muted}>No connected tools.</Text>}
        {tools?.map((tool) => (
          <View key={tool.ref} style={card}>
            <Text style={{ fontWeight: "600" }}>{tool.ref}</Text>
            {tool.description ? (
              <Text numberOfLines={3} style={muted}>
                {tool.description}
              </Text>
            ) : null}
          </View>
        ))}
      </Section>
    </Screen>
  );
}
