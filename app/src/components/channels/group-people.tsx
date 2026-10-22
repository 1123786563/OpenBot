import { IconUser, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
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
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  addGroupMemberMutationOptions,
  scopedGroupQueryOptions,
  removeGroupMemberMutationOptions,
} from "@/lib/groups";

/**
 * Who is in a group, from its top bar: how many people, and a dialog listing them where the creator
 * can take someone out, anyone else can leave, and anyone in it can add a person who has signed in
 * here. Everyone added sees the whole conversation.
 */
export function GroupPeopleButton({ channelId }: { channelId: string }) {
  const { t } = useTranslation("channels");
  const queryClient = useQueryClient();
  // The member list and every membership write ride the scope this screen holds (MT087): the
  // roster offered is the server's answer under the scope in force, and the writes carry the pair.
  const scope = useScopedCache();
  const group = useQuery(scopedGroupQueryOptions(queryClient, scope, channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const add = useMutation(
    addGroupMemberMutationOptions(queryClient, channelId, scope),
  );
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId, scope),
  );
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const people = group.data?.people ?? [];
  if (!group.data) return null;
  const iCreated = people.some(
    (person) => person.creator && person.userId === me?.id,
  );
  const count = t("group.people.count", { count: people.length });

  return (
    <>
      <Button
        className="ml-auto"
        onClick={() => setOpen(true)}
        size="sm"
        variant="ghost"
      >
        <IconUsers />
        {count}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("group.people.title")}</DialogTitle>
            <DialogDescription>
              {t("group.people.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
            <div className="overflow-hidden rounded-lg">
              {people.map((person, index) => {
                const self = person.userId === me?.id;
                const removable = self ? !person.creator : iCreated;
                return (
                  <Fragment key={person.userId}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm" variant="muted">
                      <ItemMedia variant="icon">
                        <IconUser />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {self
                            ? t("group.you")
                            : (person.name ?? person.email)}
                        </ItemTitle>
                        <ItemDescription>
                          {person.creator
                            ? t("group.people.started")
                            : person.email}
                        </ItemDescription>
                      </ItemContent>
                      {removable ? (
                        <ItemActions>
                          <Button
                            aria-label={
                              self
                                ? t("group.leaveAria")
                                : t("group.removePersonAria", {
                                    email: person.email,
                                  })
                            }
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(person.userId)}
                            size="sm"
                            variant="outline"
                          >
                            {self
                              ? t("group.people.leave")
                              : t("group.people.remove")}
                          </Button>
                        </ItemActions>
                      ) : null}
                    </Item>
                  </Fragment>
                );
              })}
            </div>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                add.mutate(email.trim(), { onSuccess: () => setEmail("") });
              }}
            >
              <Input
                aria-label={t("group.emailAria")}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t("group.people.addPlaceholder")}
                type="email"
                value={email}
              />
              <Button
                disabled={!email.trim() || add.isPending}
                size="sm"
                type="submit"
              >
                {t("group.add")}
              </Button>
            </form>
            {add.error || remove.error ? (
              <p className="text-destructive text-sm" role="alert">
                {(add.error ?? remove.error)?.message}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
