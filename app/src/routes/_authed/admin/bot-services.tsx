import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  disableBotServiceMutationOptions,
  editBotServiceMutationOptions,
  registerBotServiceMutationOptions,
} from "@/lib/bot-services/mutations";
import {
  botServiceListQueryOptions,
  type BotServiceRecord,
} from "@/lib/bot-services/queries";

export const Route = createFileRoute("/_authed/admin/bot-services")({
  component: BotServicesPage,
});

/** The capability declaration an administrator may pin — the store refuses anything else. */
const CAPABILITIES = [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
] as const;

const EMPTY_DRAFT = {
  botId: "",
  displayName: "",
  kind: "external" as "builtin" | "external",
  capabilities: ["chat"] as string[],
};

function BotServicesPage() {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const botServices = useQuery(botServiceListQueryOptions());
  const register = useMutation(registerBotServiceMutationOptions(queryClient));
  const edit = useMutation(editBotServiceMutationOptions(queryClient));
  const disable = useMutation(disableBotServiceMutationOptions(queryClient));

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState<BotServiceRecord | null>(null);
  const [editDraft, setEditDraft] = useState<{
    displayName: string;
    capabilities: string[];
  } | null>(null);
  const registerFormId = useId();
  const editFormId = useId();

  function submitRegistration(submission: React.FormEvent) {
    submission.preventDefault();
    register.mutate(
      {
        botId: draft.botId.trim(),
        displayName: draft.displayName.trim(),
        kind: draft.kind,
        capabilities: draft.capabilities,
      },
      {
        onSuccess: () => {
          setDraft(EMPTY_DRAFT);
          setAdding(false);
        },
      },
    );
  }

  function submitEdit(submission: React.FormEvent) {
    submission.preventDefault();
    if (!editing || !editDraft) return;
    edit.mutate(
      {
        botId: editing.botId,
        displayName: editDraft.displayName.trim(),
        capabilities: editDraft.capabilities,
      },
      { onSuccess: () => setEditing(null) },
    );
  }

  function toggleCapability(
    current: string[],
    capability: string,
  ): string[] {
    return current.includes(capability)
      ? current.filter((value) => value !== capability)
      : [...current, capability];
  }

  const registrationIncomplete =
    draft.botId.trim().length === 0 ||
    draft.displayName.trim().length === 0 ||
    draft.capabilities.length === 0;
  const editIncomplete =
    !editDraft ||
    editDraft.displayName.trim().length === 0 ||
    editDraft.capabilities.length === 0;

  return (
    <PageShell
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          {t("botServices.add")}
        </Button>
      }
      description={t("botServices.description")}
      title={t("botServices.title")}
    >
      {/*
       * THE WARNING IS THE PAGE'S ONE JOB. A registration grants nothing — no credential a Bot
       * could authenticate with, no person's model access, no credit permission — and the sentence
       * saying so is what keeps the screen from being read as "add a Bot and it can spend".
       */}
      <p className="text-muted-foreground text-sm">
        {t("botServices.grantsNothing")}
      </p>

      <PageSection title={t("botServices.registered.title")}>
        {botServices.isPending ? (
          <PageRowsSkeleton />
        ) : botServices.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("botServices.registered.loadError")}
          </p>
        ) : botServices.data?.length === 0 ? (
          <PageEmpty>{t("botServices.registered.empty")}</PageEmpty>
        ) : (
          <PageRows>
            {botServices.data?.map((botService, index) => (
              <StaggerItem index={index} key={botService.botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {botService.displayName}
                      {botService.status === "disabled" ? (
                        <span className="ml-2 text-muted-foreground text-sm">
                          {t("botServices.registered.disabled")}
                        </span>
                      ) : null}
                    </ItemTitle>
                    <ItemDescription>
                      {botService.botId} ·{" "}
                      {t(`botServices.kinds.${botService.kind}`)} ·{" "}
                      {botService.capabilities.join(", ")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => {
                        setEditing(botService);
                        setEditDraft({
                          displayName: botService.displayName,
                          capabilities: [...botService.capabilities],
                        });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {t("botServices.registered.edit")}
                    </Button>
                    <Button
                      disabled={
                        botService.status === "disabled" || disable.isPending
                      }
                      onClick={() => disable.mutate(botService.botId)}
                      size="sm"
                      variant="destructive"
                    >
                      {t("botServices.registered.disable")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (botServices.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
        {disable.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {disable.error.message}
          </p>
        ) : null}
      </PageSection>

      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("botServices.dialog.title")}</DialogTitle>
            <DialogDescription>
              {t("botServices.dialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches these forms by id, so DialogBody stays
                a direct child of DialogContent and keeps scrolling. */}
            <form
              className="flex flex-col gap-4"
              id={registerFormId}
              onSubmit={submitRegistration}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="botId">
                    {t("botServices.fields.botId")}
                  </FieldLabel>
                  <Input
                    id="botId"
                    onChange={(event) =>
                      setDraft({ ...draft, botId: event.target.value })
                    }
                    placeholder="support-copilot"
                    required
                    value={draft.botId}
                  />
                  <p className="text-muted-foreground text-xs">
                    {t("botServices.dialog.botIdHint")}
                  </p>
                </Field>
                <Field>
                  <FieldLabel htmlFor="displayName">
                    {t("botServices.fields.displayName")}
                  </FieldLabel>
                  <Input
                    id="displayName"
                    onChange={(event) =>
                      setDraft({ ...draft, displayName: event.target.value })
                    }
                    placeholder="Support Copilot"
                    required
                    value={draft.displayName}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="kind">
                    {t("botServices.fields.kind")}
                  </FieldLabel>
                  <Select
                    onValueChange={(value) =>
                      setDraft({ ...draft, kind: value as "builtin" | "external" })
                    }
                    value={draft.kind}
                  >
                    <SelectTrigger id="kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="builtin">
                          {t("botServices.kinds.builtin")}
                        </SelectItem>
                        <SelectItem value="external">
                          {t("botServices.kinds.external")}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{t("botServices.fields.capabilities")}</FieldLabel>
                  <div className="grid grid-cols-2 gap-2">
                    {CAPABILITIES.map((capability) => (
                      <Label
                        className="flex items-center gap-2 font-normal"
                        key={capability}
                      >
                        <Checkbox
                          checked={draft.capabilities.includes(capability)}
                          onCheckedChange={() =>
                            setDraft({
                              ...draft,
                              capabilities: toggleCapability(
                                draft.capabilities,
                                capability,
                              ),
                            })
                          }
                        />
                        {t(`botServices.capabilities.${capability}`)}
                      </Label>
                    ))}
                  </div>
                  {draft.capabilities.length === 0 ? (
                    <FieldError
                      errors={[t("botServices.dialog.capabilityRequired")]}
                    />
                  ) : null}
                </Field>
              </FieldGroup>
            </form>
            {register.error ? (
              <p className="text-destructive text-sm" role="alert">
                {register.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setAdding(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("botServices.cancel")}
            </Button>
            <Button
              disabled={registrationIncomplete || register.isPending}
              form={registerFormId}
              size="sm"
              type="submit"
            >
              {register.isPending
                ? t("botServices.dialog.saving")
                : t("botServices.dialog.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        open={editing !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("botServices.editDialog.title", {
                name: editing?.displayName ?? "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("botServices.editDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <form
              className="flex flex-col gap-4"
              id={editFormId}
              onSubmit={submitEdit}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="editDisplayName">
                    {t("botServices.fields.displayName")}
                  </FieldLabel>
                  <Input
                    id="editDisplayName"
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, displayName: event.target.value }
                          : current,
                      )
                    }
                    required
                    value={editDraft?.displayName ?? ""}
                  />
                </Field>
                <Field>
                  <FieldLabel>{t("botServices.fields.capabilities")}</FieldLabel>
                  <div className="grid grid-cols-2 gap-2">
                    {CAPABILITIES.map((capability) => (
                      <Label
                        className="flex items-center gap-2 font-normal"
                        key={capability}
                      >
                        <Checkbox
                          checked={editDraft?.capabilities.includes(
                            capability,
                          )}
                          onCheckedChange={() =>
                            setEditDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    capabilities: toggleCapability(
                                      current.capabilities,
                                      capability,
                                    ),
                                  }
                                : current,
                            )
                          }
                        />
                        {t(`botServices.capabilities.${capability}`)}
                      </Label>
                    ))}
                  </div>
                  {editDraft && editDraft.capabilities.length === 0 ? (
                    <FieldError
                      errors={[t("botServices.dialog.capabilityRequired")]}
                    />
                  ) : null}
                </Field>
              </FieldGroup>
            </form>
            {edit.error ? (
              <p className="text-destructive text-sm" role="alert">
                {edit.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setEditing(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("botServices.cancel")}
            </Button>
            <Button
              disabled={editIncomplete || edit.isPending}
              form={editFormId}
              size="sm"
              type="submit"
            >
              {edit.isPending
                ? t("botServices.dialog.saving")
                : t("botServices.editDialog.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
