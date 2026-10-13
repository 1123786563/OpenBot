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
  type CredentialFormValues,
  credentialFormSchema,
} from "@/lib/credentials/form";
import {
  createCredentialMutationOptions,
  revokeCredentialMutationOptions,
} from "@/lib/credentials/mutations";
import {
  type CredentialStatus,
  credentialListQueryOptions,
} from "@/lib/credentials/queries";

export const Route = createFileRoute("/_authed/admin/credentials")({
  component: CredentialsPage,
});

function CredentialsPage() {
  const { t } = useTranslation("admin");
  const [adding, setAdding] = useState(false);
  const formId = useId();
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const createCredential = useMutation(
    createCredentialMutationOptions(queryClient),
  );
  const revokeCredential = useMutation(
    revokeCredentialMutationOptions(queryClient),
  );
  const defaultValues: CredentialFormValues = {
    kind: "model",
    provider: "",
    keyId: "",
    plaintext: "",
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: credentialFormSchema },
    onSubmit: async ({ value }) => {
      await createCredential.mutateAsync({ ...value, metadata: {} });
      form.reset();
      setAdding(false);
    },
  });

  return (
    <PageShell
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          {t("credentials.add")}
        </Button>
      }
      description={t("credentials.description")}
      title={t("credentials.title")}
    >
      {/*
       * THE FORM IS NOT ON THE PAGE. A credential is added once and then lived with, so a permanent
       * four-field form sat above the list somebody actually came to read, and the secret field
       * invited a password manager to fill it on every visit.
       */}
      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("credentials.dialog.title")}</DialogTitle>
            <DialogDescription>
              {t("credentials.dialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={formId}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                form.handleSubmit();
              }}
            >
              <FieldGroup className="sm:grid sm:grid-cols-2">
                <form.Field name="kind">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("credentials.fields.type")}
                        </FieldLabel>
                        <Select
                          onValueChange={(value) =>
                            field.handleChange(value as "model" | "connector")
                          }
                          value={field.state.value}
                        >
                          <SelectTrigger
                            aria-invalid={isInvalid}
                            id={field.name}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="model">
                                {t("credentials.kinds.model")}
                              </SelectItem>
                              <SelectItem value="connector">
                                {t("credentials.kinds.connector")}
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {isInvalid ? (
                          <FieldError errors={field.state.meta.errors} />
                        ) : null}
                      </Field>
                    );
                  }}
                </form.Field>
                <form.Field name="provider">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("credentials.fields.provider")}
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
                            "credentials.dialog.providerPlaceholder",
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
                <form.Field name="keyId">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("credentials.fields.keyId")}
                        </FieldLabel>
                        <Input
                          aria-invalid={isInvalid}
                          id={field.name}
                          name={field.name}
                          onBlur={field.handleBlur}
                          onChange={(event) =>
                            field.handleChange(event.target.value)
                          }
                          placeholder={t("credentials.dialog.keyIdPlaceholder")}
                          value={field.state.value}
                        />
                        {isInvalid ? (
                          <FieldError errors={field.state.meta.errors} />
                        ) : null}
                      </Field>
                    );
                  }}
                </form.Field>
                <form.Field name="plaintext">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("credentials.fields.secret")}
                        </FieldLabel>
                        <Input
                          aria-invalid={isInvalid}
                          autoComplete="off"
                          id={field.name}
                          name={field.name}
                          onBlur={field.handleBlur}
                          onChange={(event) =>
                            field.handleChange(event.target.value)
                          }
                          type="password"
                          value={field.state.value}
                        />
                        {isInvalid ? (
                          <FieldError errors={field.state.meta.errors} />
                        ) : null}
                      </Field>
                    );
                  }}
                </form.Field>
              </FieldGroup>
            </form>
            {/*
             * Said before the write, not after it.
             *
             * A key holds one live credential, so saving onto a key that already has one is a
             * replacement: the old credential is revoked in the same transaction. The page calls
             * this Add and has no rotate control, so without this line an administrator retires
             * the credential an MCP server or an agent is currently authenticating with, and
             * nothing on screen mentions it until something stops working.
             */}
            <form.Subscribe
              selector={(state) => [
                state.values.kind,
                state.values.provider,
                state.values.keyId,
              ]}
            >
              {([kind, provider, keyId]) =>
                liveCredentialFor(credentials.data, kind, provider, keyId) ? (
                  <p className="text-amber-600 text-sm dark:text-amber-500">
                    {t("credentials.dialog.replaceWarning")}
                  </p>
                ) : null
              }
            </form.Subscribe>
            {createCredential.error ? (
              <p className="text-destructive text-sm" role="alert">
                {t("credentials.dialog.saveError")}
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
              {t("credentials.cancel")}
            </Button>
            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
            >
              {([canSubmit, isSubmitting]) => (
                <Button
                  disabled={
                    !canSubmit || isSubmitting || createCredential.isPending
                  }
                  form={formId}
                  size="sm"
                  type="submit"
                >
                  {isSubmitting || createCredential.isPending
                    ? t("credentials.dialog.saving")
                    : t("credentials.dialog.save")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PageSection title={t("credentials.configured.title")}>
        {credentials.isPending ? (
          <PageRowsSkeleton />
        ) : credentials.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("credentials.configured.loadError")}
          </p>
        ) : credentials.data?.length === 0 ? (
          <PageEmpty>{t("credentials.configured.empty")}</PageEmpty>
        ) : (
          <PageRows>
            {credentials.data?.map((credential, index) => (
              <StaggerItem index={index} key={credential.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{credential.provider}</ItemTitle>
                    <ItemDescription>
                      {credential.kind} · {credential.keyId} ·{" "}
                      {credential.revokedAt
                        ? t("credentials.configured.revoked")
                        : t("credentials.configured.active")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={
                        Boolean(credential.revokedAt) ||
                        revokeCredential.isPending
                      }
                      onClick={() => revokeCredential.mutate(credential.id)}
                      size="sm"
                      variant="outline"
                    >
                      {t("credentials.configured.revoke")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (credentials.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

/**
 * The live credential a key already holds, if it holds one.
 *
 * `(kind, provider, keyId)` is what `credentials_active_key_idx` is unique on, and revoked rows are
 * outside it, so this is the same question the database asks when the save lands.
 */
function liveCredentialFor(
  credentials: CredentialStatus[] | undefined,
  kind: unknown,
  provider: unknown,
  keyId: unknown,
): CredentialStatus | undefined {
  if (!provider || !keyId) return undefined;
  return credentials?.find(
    (credential) =>
      credential.revokedAt === null &&
      credential.kind === kind &&
      credential.provider === provider &&
      credential.keyId === keyId,
  );
}
