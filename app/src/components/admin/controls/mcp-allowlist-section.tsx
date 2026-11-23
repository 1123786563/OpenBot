import { IconKey, IconPlug } from "@tabler/icons-react";
import { PageRows } from "@/components/layout/page-shell";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
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
import { ControlsSection } from "./controls-section";

/** Admin, Plugins: the allowlist of MCP servers Bots may call tools on. */
export function McpAllowlistSection() {
  /*
   * Turning the gate off removes the refusal standing in front of every unapproved server, so
   * that direction asks; turning it on only adds protection and stays immediate.
   */
  const { requestConfirmation, confirmation } = useActionConfirmation();
  return (
    <ControlsSection
      description="With the allowlist on, Bots can only call tools on the MCP servers approved here. Calls to any other server are refused."
      title="MCP servers"
    >
      {({ data, setSetting, setSettingAsync, saving }) => {
        const { mcpAllowlist } = data.settings;
        return (
          <>
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconPlug />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Only approved servers</ItemTitle>
                  <ItemDescription>
                    {mcpAllowlist.enabled
                      ? `${mcpAllowlist.servers.length} approved`
                      : "Off. Bots can use any registered server they have access to."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Only approved MCP servers"
                    checked={mcpAllowlist.enabled}
                    disabled={saving}
                    onCheckedChange={(enabled) => {
                      if (enabled) {
                        setSetting("mcpAllowlist", {
                          ...mcpAllowlist,
                          enabled,
                        });
                        return;
                      }
                      requestConfirmation({
                        title: "Turn the MCP allowlist off?",
                        description:
                          "Bots could then call tools on any registered server they can reach, not only the approved ones.",
                        confirmLabel: "Turn off",
                        pendingLabel: "Turning off…",
                        failureMessage:
                          "Couldn't turn the allowlist off. Try again.",
                        variant: "destructive",
                        run: async () => {
                          await setSettingAsync("mcpAllowlist", {
                            ...mcpAllowlist,
                            enabled: false,
                          });
                        },
                      });
                    }}
                  />
                </ItemActions>
              </Item>
              {data.mcpServers.map((server) => (
                <div key={server.id}>
                  <Separator />
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <IconKey />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{server.title}</ItemTitle>
                      <ItemDescription>{server.url}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        aria-label={`Approve ${server.title}`}
                        checked={mcpAllowlist.servers.includes(server.id)}
                        disabled={saving}
                        onCheckedChange={(checked) =>
                          setSetting("mcpAllowlist", {
                            ...mcpAllowlist,
                            servers: checked
                              ? [...mcpAllowlist.servers, server.id]
                              : mcpAllowlist.servers.filter(
                                  (id) => id !== server.id,
                                ),
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                </div>
              ))}
            </PageRows>
            {confirmation}
          </>
        );
      }}
    </ControlsSection>
  );
}
