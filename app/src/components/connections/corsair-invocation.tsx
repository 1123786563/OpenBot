import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { ConnectionAction } from "@/components/connections/connection-surface";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import {
  type CorsairAccount,
  type CorsairProvider,
  corsairWrite,
} from "@/lib/connections/corsair";

const tools = z.object({ tools: z.array(z.object({ ref: z.string() })) });
const repositories = z.object({
  repositories: z.array(z.object({ id: z.string(), name: z.string() })),
});
const approval = z.object({
  id: z.uuid(),
  action: z.object({
    account: z.string(),
    target: z.object({
      connectionId: z.uuid(),
      githubUserId: z.string().optional(),
      repository: z.string().optional(),
      teamId: z.string().optional(),
      userId: z.string().optional(),
      channelId: z.string().optional(),
    }),
  }),
});
type Invocation = { botId: string; connectionId?: string } & (
  | { repositoryId: number; title: string; body?: string }
  | { channelId: string; text: string }
);
type Review = z.infer<typeof approval> & {
  request: Invocation;
  botName: string;
};

export function CorsairInvocation({
  provider,
  accounts,
  defaultId,
}: {
  provider: CorsairProvider;
  accounts: CorsairAccount[];
  defaultId: string | null | undefined;
}) {
  const github = provider === "github";
  const title = github ? "Create a GitHub issue" : "Post a Slack message";
  const [open, setOpen] = useState(false);
  const [botId, setBotId] = useState("");
  const [connectionId, setConnectionId] = useState("default");
  const [destination, setDestination] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [body, setBody] = useState("");
  const [review, setReview] = useState<Review>();
  const bots = useQuery({ ...agentListQueryOptions(), enabled: open });
  const selectedBot = bots.data?.find((bot) => bot.id === botId);
  const availableTools = useQuery({
    queryKey: ["corsair", provider, "tools", botId],
    enabled: open && Boolean(selectedBot),
    queryFn: async ({ signal }) => {
      const response = await client(
        `/api/corsair/${provider}/bots/${encodeURIComponent(botId)}/tools`,
        { signal, fallback: "Couldn't load the Bot's available actions." },
      );
      return tools.parse(await response.json()).tools;
    },
  });
  const repos = useQuery({
    queryKey: ["corsair", "github", "repositories"],
    enabled: open && github,
    queryFn: async ({ signal }) => {
      const response = await client("/api/corsair/github/repositories", {
        signal,
        fallback: "Couldn't load registered GitHub repositories.",
      });
      return repositories.parse(await response.json()).repositories;
    },
  });
  const requestApproval = useMutation({
    mutationFn: async ({
      request,
      botName,
    }: {
      request: Invocation;
      botName: string;
    }) => {
      const response = await corsairWrite(
        provider,
        "approvals",
        "POST",
        request,
      );
      return { ...approval.parse(await response.json()), request, botName };
    },
    onSuccess: setReview,
  });
  const decision = useMutation({
    mutationFn: async ({
      answer,
      review,
    }: {
      answer: "allow_once" | "deny";
      review: Review;
    }) => {
      const path = `approvals/${review.id}`;
      await corsairWrite(provider, `${path}/decision`, "POST", {
        decision: answer,
      });
      if (answer === "deny") return "declined";
      try {
        await corsairWrite(provider, `${path}/execute`, "POST", {
          ...review.request,
          connectionId: review.action.target.connectionId,
        });
        return "sent";
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : "The write could not be confirmed."} Check the destination before requesting another approval.`,
        );
      }
    },
    onSettled: () => {
      setReview(undefined);
      setOpen(false);
    },
  });

  if (!open && !accounts.length && decision.isIdle) return null;
  if (!open) {
    return (
      <VStack gap={2}>
        {decision.isSuccess ? (
          <p role="status" className="text-sm">
            {decision.data === "declined"
              ? "Approval declined."
              : github
                ? "GitHub issue created."
                : "Slack message posted."}
          </p>
        ) : null}
        {decision.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {decision.error.message}
          </p>
        ) : null}
        {accounts.length ? (
          <ConnectionAction
            variant="outline"
            onClick={() => {
              decision.reset();
              requestApproval.reset();
              setOpen(true);
            }}
          >
            {title}
          </ConnectionAction>
        ) : null}
      </VStack>
    );
  }

  if (review) {
    const { target, account } = review.action;
    return (
      <VStack gap={2}>
        <h3 className="font-medium text-sm">
          Review {github ? "GitHub issue" : "Slack message"}
        </h3>
        <p className="text-sm">Bot: {review.botName}</p>
        <p className="text-sm">
          Account: {account} (
          {github
            ? `GitHub user ${target.githubUserId}`
            : `Workspace ${target.teamId} · User ${target.userId}`}
          )
        </p>
        <p className="text-sm">
          Destination: {target.repository ?? target.channelId}
        </p>
        {"title" in review.request ? (
          <p className="text-sm">{review.request.title}</p>
        ) : null}
        <p className="whitespace-pre-wrap break-words text-sm">
          {"text" in review.request ? review.request.text : review.request.body}
        </p>
        <HStack gap={2} wrap="wrap">
          <ConnectionAction
            variant="outline"
            disabled={decision.isPending}
            onClick={() => decision.mutate({ answer: "deny", review })}
          >
            Decline
          </ConnectionAction>
          <ConnectionAction
            disabled={decision.isPending}
            onClick={() => decision.mutate({ answer: "allow_once", review })}
          >
            {decision.isPending ? "Submitting…" : "Approve and send"}
          </ConnectionAction>
        </HStack>
      </VStack>
    );
  }

  const defaultAccount = accounts.find((account) => account.id === defaultId);
  const accountAvailable =
    connectionId === "default"
      ? Boolean(defaultAccount)
      : accounts.some((account) => account.id === connectionId);
  const actionRef = github
    ? "corsair/github.create_issue"
    : "corsair/slack.post_message";
  const granted = availableTools.data?.some((tool) => tool.ref === actionRef);
  const titleTooLong = issueTitle.length > 256;
  const ready =
    granted &&
    accountAvailable &&
    (github
      ? repos.data?.some((repo) => repo.id === destination) &&
        !titleTooLong &&
        issueTitle.trim()
      : /^[CG][A-Z0-9]+$/.test(destination.trim()) && body.trim());
  const loadError = bots.error ?? availableTools.error ?? repos.error;
  const pending = requestApproval.isPending;

  return (
    <VStack gap={3}>
      <h3 className="font-medium text-sm">{title}</h3>
      <Selector
        label="Bot"
        options={(bots.data ?? []).map((bot) => ({
          value: bot.id,
          label: bot.name,
        }))}
        value={botId}
        onChange={setBotId}
        isDisabled={pending}
      />
      {availableTools.isSuccess && !granted ? (
        <p className="text-sm" role="status">
          This Bot needs access to this action.
        </p>
      ) : null}
      <Selector
        label="Account for this action"
        options={[
          {
            value: "default",
            label: defaultAccount
              ? `Use default (${defaultAccount.label})`
              : "No usable default account",
            disabled: !defaultAccount,
          },
          ...accounts.map(({ id, label, identity }) => ({
            value: id,
            label,
            description: identity,
          })),
        ]}
        value={connectionId}
        onChange={setConnectionId}
        isDisabled={pending}
      />
      {github ? (
        <>
          <Selector
            label="Repository"
            options={(repos.data ?? []).map(({ id, name }) => ({
              value: id,
              label: name,
            }))}
            value={destination}
            onChange={setDestination}
            isDisabled={pending}
          />
          <TextInput
            label="Issue title"
            value={issueTitle}
            onChange={setIssueTitle}
            isDisabled={pending}
            status={
              titleTooLong
                ? { type: "error", message: "Use 256 characters or fewer." }
                : undefined
            }
          />
        </>
      ) : (
        <TextInput
          label="Slack channel ID"
          value={destination}
          onChange={setDestination}
          isDisabled={pending}
        />
      )}
      <TextArea
        label={github ? "Issue body (optional)" : "Message"}
        value={body}
        onChange={setBody}
        isDisabled={pending}
        maxLength={github ? 32_000 : 4_000}
      />
      {loadError || requestApproval.error ? (
        <p className="text-destructive text-sm" role="alert">
          {(loadError ?? requestApproval.error)?.message}
        </p>
      ) : null}
      <HStack gap={2} wrap="wrap">
        <ConnectionAction
          variant="outline"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </ConnectionAction>
        <ConnectionAction
          disabled={!ready || pending}
          onClick={() => {
            if (!ready || !selectedBot) return;
            const account = connectionId === "default" ? {} : { connectionId };
            const args = github
              ? {
                  repositoryId: Number(destination),
                  title: issueTitle,
                  ...(body ? { body } : {}),
                }
              : { channelId: destination.trim(), text: body };
            requestApproval.mutate({
              request: { botId, ...account, ...args },
              botName: selectedBot.name,
            });
          }}
        >
          {pending ? "Preparing…" : "Review action"}
        </ConnectionAction>
      </HStack>
    </VStack>
  );
}
