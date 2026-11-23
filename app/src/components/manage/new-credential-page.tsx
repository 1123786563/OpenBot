import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ComponentProps, useRef, useState } from "react";
import { DeviceAction } from "@/components/astryx-pilot/device-action";
import { DevicePage } from "@/components/astryx-pilot/device-page";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { PageCard } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import type { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ClientError } from "@/lib/client";
import {
  type CredentialFormValues,
  credentialFormSchema,
} from "@/lib/credentials/form";
import { saveCredentialMutationOptions } from "@/lib/credentials/mutations";
import {
  type CredentialStatus,
  credentialListQueryOptions,
} from "@/lib/credentials/queries";
import { useManagePaths } from "@/lib/manage-paths";

/** Without `items` the trigger draws the raw value, so the type read "model" in lower case. */
const KIND_LABEL = { model: "Model", connector: "Connector" } as const;

function CredentialInput({
  label,
  description,
  ...props
}: Pick<
  ComponentProps<typeof Input>,
  | "aria-describedby"
  | "aria-invalid"
  | "autoComplete"
  | "id"
  | "name"
  | "onBlur"
  | "onChange"
> & {
  label: string;
  description?: string;
  type?: "password";
  value: string;
}) {
  const { name, onChange, type, value, ...input } = props;
  return (
    <TextInput
      {...input}
      description={description}
      htmlName={name}
      label={label}
      onChange={(_, event) => onChange?.(event)}
      size="lg"
      status={props["aria-invalid"] ? { type: "error" } : undefined}
      type={type}
      value={value}
      width="100%"
    />
  );
}

/**
 * Adding a credential, on a screen of its own rather than in a dialog over the list.
 *
 * A credential is added once and then lived with, so the form was never on the list page: a
 * permanent four-field form sat above the list somebody came to read, and the secret field invited a
 * password manager to fill it on every visit. Its own address keeps that, and gives the form a page's
 * room, a back button and a URL that can be linked to, as Linear does for its API keys.
 */
export function NewCredentialPage() {
  const paths = useManagePaths();
  const back = {
    label: paths.credentialsLabel,
    linkProps: paths.credentials(),
  };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const saveCredential = useMutation(
    saveCredentialMutationOptions(queryClient),
  );
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const submitButton = useRef<HTMLButtonElement>(null);
  const [saveError, setSaveError] = useState("");
  const canCheckReplacement = credentials.isSuccess && !credentials.isFetching;
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
      if (!canCheckReplacement) return;
      const input = credentialFormSchema.parse(value);
      const previous = liveCredentialFor(credentials.data, input);
      setSaveError("");

      if (previous) {
        requestConfirmation({
          title: `Replace ${previous.keyId} for ${previous.provider}?`,
          description: `This saves the new secret for ${paths.deploymentName} and permanently revokes the current one. Apps or models using the old secret may stop working.`,
          confirmLabel: "Replace credential",
          pendingLabel: "Replacing credential…",
          failureMessage:
            "Couldn't replace the credential. Your entries are still here.",
          trigger: submitButton.current ?? undefined,
          refresh: () => credentials.refetch(),
          run: async () => {
            try {
              await saveCredential.mutateAsync({
                ...input,
                metadata: {},
                previousCredentialId: previous.id,
              });
            } catch (error) {
              if (
                error instanceof ClientError &&
                [404, 409].includes(error.status)
              ) {
                throw new ActionUnavailable(
                  "The active credential changed. Close this dialog and review the replacement again.",
                );
              }
              throw error;
            }
            await navigate(paths.credentials());
          },
        });
        return;
      }

      try {
        await saveCredential.mutateAsync({
          ...input,
          metadata: {},
          previousCredentialId: null,
        });
      } catch (error) {
        if (error instanceof ClientError && error.status === 409) {
          setSaveError(
            "An active credential now exists for this key. Review it before replacing it.",
          );
          await credentials.refetch();
        } else if (error instanceof ClientError && error.status === 403) {
          setSaveError("You no longer have permission to save credentials.");
        } else {
          setSaveError(
            "Couldn't save the credential. Your entries are still here. Try again.",
          );
        }
        return;
      }
      await navigate(paths.credentials());
    },
  });

  return (
    <DevicePage
      backButton={back}
      description={`Save a credential for ${paths.deploymentName}. You won’t be able to view the secret after saving it.`}
      title="Add credential"
    >
      <form
        data-credential-form=""
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                render={(props) => <Link {...props} {...paths.credentials()} />}
                variant="outline"
              >
                Cancel
              </Button>
              <form.Subscribe
                selector={(state) => ({
                  values: state.values,
                  canSubmit: state.canSubmit,
                  isSubmitting: state.isSubmitting,
                })}
              >
                {({ values, canSubmit, isSubmitting }) => (
                  <DeviceAction
                    disabled={
                      !canCheckReplacement ||
                      !canSubmit ||
                      isSubmitting ||
                      saveCredential.isPending
                    }
                    ref={submitButton}
                    type="submit"
                  >
                    {isSubmitting || saveCredential.isPending
                      ? "Saving…"
                      : liveCredentialFor(credentials.data, values)
                        ? "Review replacement"
                        : "Save credential"}
                  </DeviceAction>
                )}
              </form.Subscribe>
            </>
          }
        >
          <VStack gap={4}>
            {credentials.isError ? (
              <ReadError
                description="Your entries are kept. Check for an existing credential before saving."
                message="Couldn't check existing credentials."
                retry={() => credentials.refetch()}
                retryBelow
                retrying={credentials.isFetching}
              />
            ) : !canCheckReplacement && !saveCredential.isPending ? (
              <ReadStatus
                kind="loading"
                message="Checking for existing credentials…"
              />
            ) : null}
            <FieldGroup>
              <form.Field name="kind">
                {(field) => {
                  const isInvalid =
                    field.state.meta.isTouched && !field.state.meta.isValid;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Type</FieldLabel>
                      <FieldDescription>
                        A model provider's key, or one a connector signs in
                        with.
                      </FieldDescription>
                      <Select
                        items={KIND_LABEL}
                        onValueChange={(value) => {
                          if (value === "model" || value === "connector")
                            field.handleChange(value);
                        }}
                        value={field.state.value}
                      >
                        <SelectTrigger
                          aria-describedby={
                            isInvalid ? `${field.name}-error` : undefined
                          }
                          aria-invalid={isInvalid}
                          className="w-full"
                          id={field.name}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent {...astryxScope}>
                          <SelectGroup>
                            <SelectItem value="model">Model</SelectItem>
                            <SelectItem value="connector">Connector</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {isInvalid ? (
                        <FieldError
                          id={`${field.name}-error`}
                          errors={field.state.meta.errors}
                        />
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
                      <CredentialInput
                        label="Provider"
                        aria-describedby={
                          isInvalid ? `${field.name}-error` : undefined
                        }
                        aria-invalid={isInvalid}
                        id={field.name}
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        description="For example, openai."
                        value={field.state.value}
                      />
                      {isInvalid ? (
                        <FieldError
                          id={`${field.name}-error`}
                          errors={field.state.meta.errors}
                        />
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
                      <CredentialInput
                        label="Key ID"
                        description="Identifies the key for this provider. For example, production."
                        aria-describedby={
                          isInvalid ? `${field.name}-error` : undefined
                        }
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
                        <FieldError
                          id={`${field.name}-error`}
                          errors={field.state.meta.errors}
                        />
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
                      <CredentialInput
                        label="Secret"
                        aria-describedby={
                          isInvalid ? `${field.name}-error` : undefined
                        }
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
                        <FieldError
                          id={`${field.name}-error`}
                          errors={field.state.meta.errors}
                        />
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
            </FieldGroup>
            {saveError ? (
              <Text as="p" role="alert">
                {saveError}
              </Text>
            ) : null}
          </VStack>
        </PageCard>
      </form>
      {confirmation}
    </DevicePage>
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
  {
    kind,
    provider,
    keyId,
  }: Pick<CredentialFormValues, "kind" | "provider" | "keyId">,
): CredentialStatus | undefined {
  const providerKey = provider.trim();
  const credentialKey = keyId.trim();
  return credentials?.find(
    (credential) =>
      credential.revokedAt === null &&
      credential.kind === kind &&
      credential.provider === providerKey &&
      credential.keyId === credentialKey,
  );
}
