import { VStack } from "@astryxdesign/core/Stack";
import {
  publishedSkillCatalog,
  publishedSkillDetail,
} from "@openbot/shared/direct-chat-learning";
import { IconBook } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { client } from "@/lib/client";
import { learningKeys } from "@/lib/learning/queries";

const path = "/api/copilotkit/learning/skills";
const catalogKey = learningKeys.publishedSkills;

function SkillDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const detailPath = `${path}/${encodeURIComponent(id)}`;
  const queryKey = [...catalogKey, id];
  const detail = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      publishedSkillDetail.parse(
        await (
          await client(detailPath, {
            signal,
            fallback: "Couldn't load this skill.",
          })
        ).json(),
      ),
    retry: false,
    gcTime: 0,
  });
  const change = useMutation({
    mutationFn: (action: { email: string } | { recipientId: string }) =>
      "email" in action
        ? client(`${detailPath}/shares`, {
            method: "POST",
            body: action,
            fallback: "Couldn't share this skill.",
          })
        : client(
            `${detailPath}/shares/${encodeURIComponent(action.recipientId)}`,
            {
              method: "DELETE",
              fallback: "Couldn't revoke this share.",
            },
          ),
    onMutate: () => setNotice(""),
    onSuccess: (_response, action) => {
      setNotice("email" in action ? "Skill shared." : "Share revoked.");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: catalogKey }),
  });

  const skill = detail.isError ? undefined : detail.data;
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{skill?.title ?? "Published skill"}</DialogTitle>
        <DialogDescription>
          {skill?.botName ?? "Approved Bot guidance"}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <VStack gap={3}>
          {detail.isPending && <p role="status">Loading skill…</p>}
          {detail.error && (
            <VStack gap={2}>
              <p role="alert">{detail.error.message}</p>
              <Button variant="outline" onClick={() => void detail.refetch()}>
                Retry
              </Button>
            </VStack>
          )}
          {skill && (
            <>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {skill.instructions}
              </p>
              {skill.canShare && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (change.isPending) return;
                    const form = event.currentTarget;
                    const email = new FormData(form).get("email");
                    if (typeof email === "string") {
                      change.mutate(
                        { email: email.trim() },
                        {
                          onSuccess: () => form.reset(),
                        },
                      );
                    }
                  }}
                >
                  <VStack gap={2}>
                    <Label htmlFor="published-skill-recipient">
                      Recipient email
                    </Label>
                    <Input
                      id="published-skill-recipient"
                      name="email"
                      type="email"
                      required
                      aria-describedby="published-skill-recipient-help"
                    />
                    <p id="published-skill-recipient-help">
                      The recipient needs access to every source conversation
                      and a direct conversation with this Bot.
                    </p>
                    <Button type="submit" disabled={change.isPending}>
                      Share skill
                    </Button>
                  </VStack>
                </form>
              )}
              {skill.shares.map(({ recipientId, email }) => (
                <Item key={recipientId}>
                  <ItemContent>
                    <ItemTitle>{email}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Revoke sharing with ${email}`}
                      disabled={change.isPending}
                      onClick={() => change.mutate({ recipientId })}
                    >
                      Revoke
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </>
          )}
          {change.error && <p role="alert">{change.error.message}</p>}
          {notice && <p role="status">{notice}</p>}
        </VStack>
      </DialogBody>
    </DialogContent>
  );
}

export function NativeLearningSkills() {
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = useQuery({
    queryKey: catalogKey,
    queryFn: async ({ signal }) =>
      publishedSkillCatalog.parse(
        await (
          await client(path, {
            signal,
            fallback: "Couldn't load published skills.",
          })
        ).json(),
      ),
    retry: false,
    gcTime: 0,
  });
  const skills = catalog.isError ? [] : (catalog.data?.skills ?? []);
  return (
    <PageSection
      title="Published skills"
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={catalog.isFetching}
          onClick={() => void catalog.refetch()}
        >
          Refresh skills
        </Button>
      }
    >
      <VStack gap={3}>
        {catalog.isPending && <p role="status">Loading published skills…</p>}
        {catalog.error && (
          <VStack gap={2}>
            <p role="alert">{catalog.error.message}</p>
            <Button variant="outline" onClick={() => void catalog.refetch()}>
              Retry
            </Button>
          </VStack>
        )}
        {catalog.isSuccess && skills.length === 0 && (
          <PageEmpty icon={IconBook} title="No published skills available" />
        )}
        {skills.length > 0 && (
          <PageRows>
            {skills.map(({ id, title, botName, access }) => (
              <Item key={id}>
                <ItemContent>
                  <ItemTitle>{title}</ItemTitle>
                  <ItemDescription>
                    {botName} ·{" "}
                    {access === "owned" ? "Yours" : "Shared with you"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`View ${title}`}
                    onClick={() => setSelected(id)}
                  >
                    View
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </PageRows>
        )}
        <Dialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          {selected && <SkillDetail key={selected} id={selected} />}
        </Dialog>
      </VStack>
    </PageSection>
  );
}
