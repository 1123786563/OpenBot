import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ComponentProps, ReactNode } from "react";
import { ToolRenderBoundary } from "@/components/channels/tool-boundary";

/**
 * What the host says in place of a sandboxed component.
 *
 * Loading: nothing is drawn yet. Refused: a policy said no. Error: it tried and didn't work.
 * Notice: there is nothing to draw, for an ordinary reason.
 */
export type SandboxStatus =
  | { kind: "loading"; message: string }
  | { kind: "refused"; message: string; description?: string }
  | { kind: "error"; message: string; description?: string; action?: ReactNode }
  | { kind: "notice"; message: string };

/**
 * The frame around a published component, in a conversation, in a preview and in the Playground.
 *
 * The component itself runs unchanged in the CopilotKit sandbox. Everything outside it is drawn
 * here: the title, host actions, and what to say while it loads, when it is refused, when it can't
 * be drawn and when drawing it fails. A failure stays inside this frame, so the rest of the
 * conversation stays on screen.
 */
export function SandboxHost({
  title,
  headingLevel,
  action,
  status,
  variant = "default",
  children,
  ...frame
}: {
  /** The component's name, shown above it. Omit where the page already names it. */
  title?: string;
  /** Where the title is also a section of its page, and belongs in the outline: an `h2` there. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** A host action, drawn beside the title: "Back to editor", "Retry". */
  action?: ReactNode;
  /** Shown in place of the component. Without it, the component is drawn. */
  status?: SandboxStatus;
  /**
   * `transparent` for a tile that has its own border and artwork: there the frame would be a box
   * inside a box.
   */
  variant?: ComponentProps<typeof Card>["variant"];
  children?: ReactNode;
} & Omit<ComponentProps<typeof Card>, "variant">) {
  return (
    <Card data-sandbox-host="" padding={0} variant={variant} {...frame}>
      {(title || action) && (
        <>
          <Stack
            align="center"
            justify="between"
            paddingBlock={2}
            paddingInline={4}
            wrap="wrap"
          >
            {title ? (
              headingLevel ? (
                <Heading level={headingLevel} maxLines={1}>
                  {title}
                </Heading>
              ) : (
                <Text color="primary" maxLines={1} type="label" weight="medium">
                  {title}
                </Text>
              )
            ) : null}
            {action}
          </Stack>
          <Divider />
        </>
      )}
      {status ? (
        <Stack padding={3}>
          <SandboxStatusView status={status} />
        </Stack>
      ) : (
        <ToolRenderBoundary name={title ?? "component"}>
          {children}
        </ToolRenderBoundary>
      )}
    </Card>
  );
}

export function SandboxStatusView({ status }: { status: SandboxStatus }) {
  switch (status.kind) {
    case "loading":
      return (
        <Stack hAlign="center" role="status">
          <Spinner label={status.message} />
        </Stack>
      );
    case "refused":
    case "error":
      return (
        <Banner
          description={status.description}
          endContent={status.kind === "error" ? status.action : undefined}
          status={status.kind === "refused" ? "warning" : "error"}
          title={status.message}
        />
      );
    default:
      return <Banner status="info" title={status.message} />;
  }
}
