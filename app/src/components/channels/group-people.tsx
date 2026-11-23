import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { canKeepCachedRead } from "@/lib/client";
import {
  addGroupMemberMutationOptions,
  groupQueryOptions,
  removeGroupMemberMutationOptions,
} from "@/lib/groups";

/**
 * Who is in a group, from its top bar: how many people, and a dialog listing them where the creator
 * can take someone out, anyone else can leave, and anyone in it can add a person who has signed in
 * here. Everyone added sees the whole conversation.
 */
export function GroupPeopleButton({
  channelId,
  onLeave,
}: {
  channelId: string;
  onLeave: () => void;
}) {
  const queryClient = useQueryClient();
  const group = useQuery(groupQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const add = useMutation(
    addGroupMemberMutationOptions(queryClient, channelId),
  );
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId),
  );
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [added, setAdded] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const dialogTitle = useRef<HTMLHeadingElement>(null);
  const peopleHeading = useRef<HTMLHeadingElement>(null);
  if (!group.data || !canKeepCachedRead(group.error)) return null;
  const { bots, people } = group.data;
  const membership = people.find((person) => person.userId === me?.id);
  const botCount = `${bots.length} ${bots.length === 1 ? "Bot" : "Bots"}`;
  const peopleCount = `${people.length} ${people.length === 1 ? "person" : "people"}`;

  return (
    <>
      <Button
        ref={opener}
        className="group-participants-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        label={`${botCount} · ${peopleCount}`}
        onClick={() => setOpen(true)}
        size="sm"
        variant="ghost"
      />
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          {...astryxScope}
          className="group-participants-dialog"
          finalFocus={opener}
          initialFocus={dialogTitle}
        >
          <DialogHeader>
            <DialogTitle ref={dialogTitle} tabIndex={-1}>
              Group participants
            </DialogTitle>
            <DialogDescription>
              Everyone listed under People can read the full conversation.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Stack gap={4}>
              <Stack gap={2}>
                <Heading level={3}>{botCount}</Heading>
                {bots.length ? (
                  <List edge="flush" listStyle="decimal">
                    {bots.map((bot) => (
                      <ListItem key={bot.id} label={<Text>{bot.name}</Text>} />
                    ))}
                  </List>
                ) : (
                  <Text type="supporting">No Bots are available to reply.</Text>
                )}
              </Stack>
              <Stack gap={2}>
                <Heading level={3} ref={peopleHeading} tabIndex={-1}>
                  People
                </Heading>
                <List edge="flush" hasDividers>
                  {people.map((person) => {
                    const self = person.userId === me?.id;
                    const name = person.name ?? person.email;
                    const removable =
                      self || (membership?.creator && !person.creator);
                    return (
                      <ListItem
                        key={person.userId}
                        label={<Text>{self ? "You" : name}</Text>}
                        description={
                          <Text
                            as="p"
                            type="supporting"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {person.creator
                              ? "Started this group"
                              : person.email}
                          </Text>
                        }
                        endContent={
                          removable && (
                            <Button
                              aria-label={
                                self
                                  ? "Leave this group"
                                  : `Remove ${person.email}`
                              }
                              isDisabled={remove.isPending}
                              label={self ? "Leave" : "Remove"}
                              onClick={(event) =>
                                requestConfirmation({
                                  title: self
                                    ? "Leave this group?"
                                    : `Remove ${name}?`,
                                  description: self
                                    ? "You’ll lose access to this conversation. A member can add you again."
                                    : `${name} will lose access to this conversation. A member can add them again.`,
                                  confirmLabel: self
                                    ? "Leave group"
                                    : "Remove person",
                                  pendingLabel: self ? "Leaving…" : "Removing…",
                                  failureMessage: self
                                    ? "Couldn’t leave the group. Try again."
                                    : "Couldn’t remove this person. Try again.",
                                  fallbackFocus: () => peopleHeading.current,
                                  successMessage: `${name} was removed from the group.`,
                                  trigger: event.currentTarget,
                                  run: async () => {
                                    await remove.mutateAsync(person.userId);
                                    if (self) {
                                      setOpen(false);
                                      onLeave();
                                    }
                                  },
                                })
                              }
                              size="sm"
                              variant="secondary"
                            />
                          )
                        }
                      />
                    );
                  })}
                </List>
              </Stack>
              {membership ? (
                <Stack
                  as="form"
                  align="start"
                  gap={2}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const address = email.trim();
                    if (!address || add.isPending) return;
                    setAdded("");
                    add.mutate(address, {
                      onSuccess: () => {
                        setEmail("");
                        setAdded(`Added ${address}.`);
                      },
                    });
                  }}
                >
                  <TextInput
                    label="Add someone by email"
                    description="They need an OpenBot account and will see the conversation history."
                    type="email"
                    value={email}
                    onChange={setEmail}
                  />
                  <Button
                    isDisabled={!email.trim()}
                    isLoading={add.isPending}
                    label="Add to group"
                    type="submit"
                    variant="primary"
                  />
                  {add.error && (
                    <Text
                      as="p"
                      style={{ color: "var(--color-text-error)" }}
                      role="alert"
                    >
                      {add.error.message}
                    </Text>
                  )}
                  {added && (
                    <Text as="p" role="status">
                      {added}
                    </Text>
                  )}
                </Stack>
              ) : null}
              {confirmation}
            </Stack>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
