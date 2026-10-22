import { IconPlus } from "@tabler/icons-react";
import { useForm } from "@tanstack/react-form";
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
  type BotServiceEdit,
  type BotServiceRegistration,
  editBotServiceMutationOptions,
  registerBotServiceMutationOptions,
  setBotServiceStatusMutationOptions,
} from "@/lib/bot-services/mutations";
import {
  BOT_SERVICE_CAPABILITIES,
  type BotService,
  botServiceListQueryOptions,
} from "@/lib/bot-services/queries";

export const Route = createFileRoute("/_authed/admin/bot-services")({
  component: BotServicesPage,
});

/**
 * The Bifrost bot service registry (Bifrost #234, 04.1): which server-side Bots this deployment
 * recognizes at all.
 *
 * Registration mints an identity and a declaration, nothing else — no credential field is shown
 * or sent anywhere on this page, because none exists to show (04.2 mints service credentials under
 * its own narrower trigger). Disabling is the switch that makes every downstream refusal honest:
 * the disabled status is what authentication and key issuance read before acting for a Bot.
 */

const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/**
 * The label key for each capability, spelled out so the i18next typed keys accept it (a template
 * literal over `string` widens past them), and so an unknown value from a future registry falls
 * back to the raw name rather than a missing translation.
 */
const CAPABILITY_LABEL_KEYS = {
  chat: "botServices.capabilities.chat",
  image: "botServices.capabilities.image",
  audio: "botServices.capabilities.audio",
  embedding: "botServices.capabilities.embedding",
  realtime: "botServices.capabilities.realtime",
  async: "botServices.capabilities.async",
} as const satisfies Record<(typeof BOT_SERVICE_CAPABILITIES)[number], string>;

const capabilityLabel = (t: Translate, capability: string) =>
  capability in CAPABILITY_LABEL_KEYS
    ? t(
        CAPABILITY_LABEL_KEYS[
          capability as (typeof BOT_SERVICE_CAPABILITIES)[number]
        ],
      )
    : capability;

function BotServicesPage() {
  const { t } = useTranslation("admin");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BotService | null>(null);
  const queryClient = useQueryClient();
  const botServices = useQuery(botServiceListQueryOptions());
  const register = useMutation(registerBotServiceMutationOptions(queryClient));
  const edit = useMutation(editBotServiceMutationOptions(queryClient));
  const setStatus = useMutation(
    setBotServiceStatusMutationOptions(queryClient),
  );

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
      <RegisterDialog
        onDone={() => setAdding(false)}
        open={adding}
        register={register}
        t={t}
      />
      {editing ? (
        <EditDialog
          botService={editing}
          edit={edit}
          onDone={() => setEditing(null)}
          t={t}
        />
      ) : null}

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
                      {botService.status === "disabled"
                        ? ` · ${t("botServices.registered.disabled")}`
                        : ""}
                    </ItemTitle>
                    <ItemDescription>
                      {botService.botId} ·{" "}
                      {t(`botServices.kinds.${botService.kind}`)} ·{" "}
                      {botService.capabilities
                        .map((capability) => capabilityLabel(t, capability))
                        .join(", ")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={setStatus.isPending}
                      onClick={() => setEditing(botService)}
                      size="sm"
                      variant="outline"
                    >
                      {t("botServices.registered.edit")}
                    </Button>
                    <Button
                      disabled={setStatus.isPending}
                      onClick={() =>
                        setStatus.mutate({
                          botId: botService.botId,
                          status:
                            botService.status === "disabled"
                              ? "active"
                              : "disabled",
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      {botService.status === "disabled"
                        ? t("botServices.registered.enable")
                        : t("botServices.registered.disable")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (botServices.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

/** The shape the dialogs need from a mutation, decoupled from react-query's generics. */
type MutationOf<TInput> = {
  mutateAsync: (input: TInput) => Promise<unknown>;
  isPending: boolean;
  error: Error | null;
};

type Translate = ReturnType<typeof useTranslation<"admin">>["t"];

function RegisterDialog({
  onDone,
  open,
  register,
  t,
}: {
  onDone: (open: boolean) => void;
  open: boolean;
  register: MutationOf<BotServiceRegistration>;
  t: Translate;
}) {
  const formId = useId();
  // Checkbox ids need their own prefix: the form id is already taken by the <form> element.
  const capabilityFieldId = `${formId}-capability`;
  const form = useForm({
    defaultValues: {
      botId: "",
      displayName: "",
      kind: "external" as "builtin" | "external",
      capabilities: ["chat"] as string[],
    },
    validators: {
      onSubmit: ({ value }) => {
        const problems: string[] = [];
        if (!BOT_ID_PATTERN.test(value.botId.trim()))
          problems.push(t("botServices.form.botIdInvalid"));
        if (!value.displayName.trim())
          problems.push(t("botServices.form.displayNameRequired"));
        if (value.capabilities.length === 0)
          problems.push(t("botServices.form.capabilitiesRequired"));
        return problems.length ? problems : undefined;
      },
    },
    onSubmit: async ({ value }) => {
      await register.mutateAsync({
        botId: value.botId.trim(),
        displayName: value.displayName.trim(),
        kind: value.kind,
        capabilities: value.capabilities,
      });
      form.reset();
      onDone(false);
    },
  });

  return (
    <Dialog onOpenChange={onDone} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("botServices.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("botServices.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
          >
            <FieldGroup className="sm:grid sm:grid-cols-2">
              <form.Field name="botId">
                {(field) => {
                  const isInvalid =
                    field.state.meta.isTouched && !field.state.meta.isValid;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>
                        {t("botServices.fields.botId")}
                      </FieldLabel>
                      <Input
                        aria-invalid={isInvalid}
                        id={field.name}
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        placeholder={t("botServices.dialog.botIdPlaceholder")}
                        value={field.state.value}
                      />
                      {isInvalid ? (
                        <FieldError errors={field.state.meta.errors} />
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Field name="displayName">
                {(field) => {
                  const isInvalid =
                    field.state.meta.isTouched && !field.state.meta.isValid;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>
                        {t("botServices.fields.displayName")}
                      </FieldLabel>
                      <Input
                        aria-invalid={isInvalid}
                        id={field.name}
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        placeholder={t(
                          "botServices.dialog.displayNamePlaceholder",
                        )}
                        value={field.state.value}
                      />
                      {isInvalid ? (
                        <FieldError errors={field.state.meta.errors} />
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Field name="kind">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>
                      {t("botServices.fields.kind")}
                    </FieldLabel>
                    <Select
                      onValueChange={(value) => {
                        // null is the Select's "no selection", not a kind: dropping it keeps the
                        // form's previous answer rather than casting emptiness into "builtin".
                        if (value === null) return;
                        field.handleChange(value);
                      }}
                      value={field.state.value}
                    >
                      <SelectTrigger id={field.name}>
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
                )}
              </form.Field>
              <form.Field name="capabilities">
                {(field) => (
                  <Field>
                    <FieldLabel>
                      {t("botServices.fields.capabilities")}
                    </FieldLabel>
                    <div className="grid grid-cols-2 gap-2">
                      {BOT_SERVICE_CAPABILITIES.map((capability) => (
                        <label
                          className="flex items-center gap-2 text-sm"
                          htmlFor={`${capabilityFieldId}-${capability}`}
                          key={capability}
                        >
                          <Checkbox
                            checked={field.state.value.includes(capability)}
                            id={`${capabilityFieldId}-${capability}`}
                            onCheckedChange={(checked) =>
                              field.handleChange(
                                checked
                                  ? [...field.state.value, capability]
                                  : field.state.value.filter(
                                      (item) => item !== capability,
                                    ),
                              )
                            }
                          />
                          {capabilityLabel(t, capability)}
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
              </form.Field>
            </FieldGroup>
          </form>
          {/*
           * Said in the dialog, not discovered later: registering mints no credential and grants
           * nobody anything — it only says this Bot exists and may be given one later.
           */}
          <p className="mt-4 text-muted-foreground text-sm">
            {t("botServices.dialog.noCredentials")}
          </p>
          {register.error ? (
            <p className="text-destructive text-sm" role="alert">
              {register.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onDone(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("botServices.cancel")}
          </Button>
          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, isSubmitting]) => (
              <Button
                disabled={!canSubmit || isSubmitting || register.isPending}
                form={formId}
                size="sm"
                type="submit"
              >
                {isSubmitting || register.isPending
                  ? t("botServices.dialog.saving")
                  : t("botServices.dialog.save")}
              </Button>
            )}
          </form.Subscribe>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  botService,
  edit,
  onDone,
  t,
}: {
  botService: BotService;
  edit: MutationOf<{ botId: string; edit: BotServiceEdit }>;
  onDone: () => void;
  t: Translate;
}) {
  const formId = useId();
  // Checkbox ids need their own prefix: the form id is already taken by the <form> element.
  const capabilityFieldId = `${formId}-capability`;
  const form = useForm({
    defaultValues: {
      displayName: botService.displayName,
      capabilities: botService.capabilities,
    },
    validators: {
      onSubmit: ({ value }) => {
        const problems: string[] = [];
        if (!value.displayName.trim())
          problems.push(t("botServices.form.displayNameRequired"));
        if (value.capabilities.length === 0)
          problems.push(t("botServices.form.capabilitiesRequired"));
        return problems.length ? problems : undefined;
      },
    },
    onSubmit: async ({ value }) => {
      await edit.mutateAsync({
        botId: botService.botId,
        edit: {
          displayName: value.displayName.trim(),
          capabilities: value.capabilities,
        },
      });
      onDone();
    },
  });

  return (
    <Dialog onOpenChange={(open) => (!open ? onDone() : undefined)} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("botServices.edit.title")}</DialogTitle>
          <DialogDescription>{botService.botId}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="displayName">
                {(field) => {
                  const isInvalid =
                    field.state.meta.isTouched && !field.state.meta.isValid;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>
                        {t("botServices.fields.displayName")}
                      </FieldLabel>
                      <Input
                        aria-invalid={isInvalid}
                        id={field.name}
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        value={field.state.value}
                      />
                      {isInvalid ? (
                        <FieldError errors={field.state.meta.errors} />
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Field name="capabilities">
                {(field) => (
                  <Field>
                    <FieldLabel>
                      {t("botServices.fields.capabilities")}
                    </FieldLabel>
                    <div className="grid grid-cols-2 gap-2">
                      {BOT_SERVICE_CAPABILITIES.map((capability) => (
                        <label
                          className="flex items-center gap-2 text-sm"
                          htmlFor={`${capabilityFieldId}-${capability}`}
                          key={capability}
                        >
                          <Checkbox
                            checked={field.state.value.includes(capability)}
                            id={`${capabilityFieldId}-${capability}`}
                            onCheckedChange={(checked) =>
                              field.handleChange(
                                checked
                                  ? [...field.state.value, capability]
                                  : field.state.value.filter(
                                      (item) => item !== capability,
                                    ),
                              )
                            }
                          />
                          {capabilityLabel(t, capability)}
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
              </form.Field>
            </FieldGroup>
          </form>
          {edit.error ? (
            <p className="text-destructive text-sm" role="alert">
              {edit.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onDone} size="sm" type="button" variant="ghost">
            {t("botServices.cancel")}
          </Button>
          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, isSubmitting]) => (
              <Button
                disabled={!canSubmit || isSubmitting || edit.isPending}
                form={formId}
                size="sm"
                type="submit"
              >
                {isSubmitting || edit.isPending
                  ? t("botServices.dialog.saving")
                  : t("botServices.dialog.save")}
              </Button>
            )}
          </form.Subscribe>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
