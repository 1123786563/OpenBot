import { OpenGenerativeUIActivityRenderer } from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import "@/components/astryx-pilot/capability-surface.css";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { SandboxHost } from "@/components/gallery/sandbox-host";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  ActionIncomplete,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ClientError } from "@/lib/client";
import {
  deleteSandboxedMutationOptions,
  publishSandboxedMutationOptions,
  type SandboxedDraftInput,
  saveSandboxedDraftMutationOptions,
} from "@/lib/sandboxed/mutations";
import {
  type SandboxedRecord,
  sandboxedListQueryOptions,
} from "@/lib/sandboxed/queries";

/**
 * Browser-authored components are edited as drafts, previewed in the production sandbox renderer,
 * and used by conversations only after publishing.
 */
export const Route = createFileRoute("/_authed/admin/playground")({
  component: PlaygroundPage,
});

const STARTER = {
  slug: "",
  title: "",
  description: "",
  html: `<div class="card">\n  <h3 id="title">Untitled</h3>\n  <p id="body"></p>\n</div>`,
  css: `.card { font: 14px system-ui; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; }\n.card h3 { margin: 0 0 4px; font-size: 15px; }`,
  jsFunctions: `// The arguments are on window.__args by the time this runs.\nconst args = window.__args || {};\ndocument.getElementById("title").textContent = args.title || "Untitled";\ndocument.getElementById("body").textContent = args.body || "";`,
  argumentSchema: `{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" },\n    "body": { "type": "string" }\n  }\n}`,
  sampleArguments: `{\n  "title": "A worked example",\n  "body": "Edit the panels on the left and this redraws."\n}`,
};

type Draft = typeof STARTER;

type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

type PlaygroundValidation =
  | { ok: true; input: SandboxedDraftInput }
  | {
      ok: false;
      fields: { argumentSchema?: string; sampleArguments?: string };
    };

function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function parseJsonObject(raw: string, label: string): JsonObjectResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (thrown) {
    const reason =
      thrown instanceof SyntaxError ? thrown.message : "invalid JSON";
    return { ok: false, message: `${label} must be valid JSON: ${reason}` };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      message: `${label} must be a JSON object, not ${jsonKind(value)}.`,
    };
  }

  return { ok: true, value: value as Record<string, unknown> };
}

export function validatePlaygroundDraft(draft: Draft): PlaygroundValidation {
  const schema = parseJsonObject(
    draft.argumentSchema,
    "Arguments (JSON Schema)",
  );
  const sample = parseJsonObject(draft.sampleArguments, "Sample arguments");
  if (!schema.ok || !sample.ok) {
    return {
      ok: false,
      fields: {
        ...(!schema.ok ? { argumentSchema: schema.message } : {}),
        ...(!sample.ok ? { sampleArguments: sample.message } : {}),
      },
    };
  }

  return {
    ok: true,
    input: {
      slug: draft.slug,
      title: draft.title,
      description: draft.description,
      html: draft.html,
      css: draft.css,
      jsFunctions: draft.jsFunctions,
      argumentSchema: schema.value,
      sampleArguments: sample.value,
    },
  };
}

function PlaygroundPage() {
  const { confirmation, requestConfirmation } = useActionConfirmation();
  const queryClient = useQueryClient();
  const savedList = useQuery(sandboxedListQueryOptions());
  const components = savedList.data;
  const [draft, setDraft] = useState<Draft>(STARTER);
  const [savedDraft, setSavedDraft] = useState<Draft>(STARTER);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savedHeading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);

  const set = (field: keyof Draft) => (value: string) => {
    setError(null);
    setNotice(null);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const validation = validatePlaygroundDraft(draft);
  const sample = validation.ok ? validation.input.sampleArguments : null;

  const saveDraft = useMutation({
    ...saveSandboxedDraftMutationOptions(queryClient),
    onError: () => setError("Couldn't save. Your edits are still on screen."),
    onSettled: () => {
      submitting.current = false;
    },
  });
  const publishDraft = useMutation(
    publishSandboxedMutationOptions(queryClient),
  );
  const removeComponent = useMutation(
    deleteSandboxedMutationOptions(queryClient),
  );
  const busy =
    saveDraft.isPending || publishDraft.isPending || removeComponent.isPending;
  const canWrite = Boolean(draft.slug && draft.title) && validation.ok && !busy;

  const input = (): SandboxedDraftInput | null => {
    const current = validatePlaygroundDraft(draft);
    if (!current.ok) {
      setNotice(null);
      setError(
        Object.values(current.fields)[0] ??
          "Fix the JSON fields before saving.",
      );
      return null;
    }
    return current.input;
  };

  const save = () => {
    setError(null);
    setNotice(null);
    const payload = input();
    if (!payload || submitting.current) return;
    submitting.current = true;
    saveDraft.mutate(payload, {
      onSuccess: () => {
        setSavedDraft(draft);
        setNotice("Draft saved.");
      },
    });
  };

  /* Publishing reaches every Bot at once, so it asks first, like Delete. */
  const publish = (trigger: HTMLButtonElement) => {
    setError(null);
    setNotice(null);
    const payload = input();
    if (!payload) return;
    requestConfirmation({
      title: `Publish ${draft.title}?`,
      description:
        "Publishing makes it available to every Bot. Turn it off for one Bot on the UI components page.",
      confirmLabel: "Publish",
      pendingLabel: "Publishing…",
      failureMessage: "Couldn't publish it. Try again.",
      successMessage: "Published.",
      trigger,
      run: async () => {
        let draftSaved = false;
        submitting.current = true;
        try {
          await publishDraft.mutateAsync({
            input: payload,
            onDraftSaved: () => {
              draftSaved = true;
              setSavedDraft(draft);
            },
          });
        } catch (error) {
          if (
            error instanceof ClientError &&
            [401, 403, 404, 409].includes(error.status)
          )
            throw error;
          throw new ActionIncomplete(
            draftSaved
              ? "Draft saved. Couldn’t confirm publication. Try again."
              : "Couldn’t save the draft for publication. Your edits are still in the editor.",
          );
        } finally {
          submitting.current = false;
        }
      },
    });
  };

  const open = (component: SandboxedRecord, trigger: HTMLElement) => {
    const next: Draft = {
      slug: component.name.replace(/^custom_/, ""),
      title: component.title,
      description: component.draftDescription,
      html: component.draftHtml,
      css: component.draftCss,
      jsFunctions: component.draftJsFunctions,
      argumentSchema: JSON.stringify(component.draftArgumentSchema, null, 2),
      sampleArguments: JSON.stringify(component.sampleArguments, null, 2),
    };
    const load = () => {
      setDraft(next);
      setSavedDraft(next);
      setError(null);
      setNotice(null);
    };
    if (!dirty) {
      load();
      return;
    }
    requestConfirmation({
      title: "Discard unsaved edits?",
      description: `Opening ${component.title} will replace the draft in the editor.`,
      confirmLabel: "Discard and open",
      pendingLabel: "Opening…",
      failureMessage: "Couldn't open this component. Try again.",
      trigger,
      run: async () => load(),
    });
  };

  function remove(component: SandboxedRecord, trigger: HTMLButtonElement) {
    requestConfirmation({
      title: `Delete ${component.title}?`,
      description:
        "This removes the component from the deployment. Bots will no longer be able to show it.",
      confirmLabel: "Delete component",
      pendingLabel: "Deleting…",
      failureMessage: `Couldn’t delete ${component.title}. Try again.`,
      successMessage: `Deleted ${component.title}.`,
      fallbackFocus: () => savedHeading.current,
      trigger,
      run: async () => {
        submitting.current = true;
        try {
          await removeComponent.mutateAsync(component.name);
          if (`custom_${draft.slug}` === component.name) {
            setSavedDraft(STARTER);
            if (!dirty) setDraft(STARTER);
          }
          setError(null);
          setNotice(null);
        } finally {
          submitting.current = false;
        }
      },
    });
  }

  return (
    /*
     * THE ONE PAGE THAT KEEPS ITS OWN GEOMETRY. Everything else in admin is a column you scroll;
     * this is an editor beside a live preview, and the preview is the entire point — put it in the
     * standard prose column and it lands below the fold, so you would be typing at something you
     * cannot see. It takes the header and the controls, and keeps the two panes.
     */
    <div
      {...astryxScope}
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        "astryx-capability-surface",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-border border-b px-6 py-4">
        {/* Inline rather than in a band of its own: this screen is an editor beside a live preview
            and every 48px of height is taken from the thing being previewed. */}
        <div className="flex items-start gap-2">
          <SidebarToggle className="-ml-2 shrink-0" />
          <div>
            <h1
              className="font-semibold text-2xl tracking-tight"
              id="playground-editor"
              ref={editorHeading}
              tabIndex={-1}
            >
              Playground
            </h1>
            <p className="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed">
              Edit and preview a component here. Bots show the published version
              in conversations.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The JSON fields explain their own invalid state inline; these two names are
              the only inputs whose absence disables the buttons without a visible reason. */}
          {!canWrite && !busy && (!draft.slug || !draft.title) ? (
            <p className="text-muted-foreground text-xs">
              Name and title are needed first.
            </p>
          ) : null}
          <Button
            aria-label="Go to preview"
            className="confirmation-action"
            onClick={() => previewHeading.current?.focus()}
            size="sm"
            type="button"
            variant="ghost"
          >
            Preview
          </Button>
          <Button
            className="confirmation-action"
            disabled={!canWrite}
            onClick={save}
            size="sm"
            type="button"
            variant="outline"
          >
            Save draft
          </Button>
          <Button
            /* `publish` saves first, since publishing acts on the stored draft, not the editors. */
            disabled={!canWrite}
            className="confirmation-action"
            onClick={(event) => publish(event.currentTarget)}
            size="sm"
            type="button"
          >
            Publish
          </Button>
        </div>
      </header>

      <section style={{ paddingInline: "var(--spacing-6)" }}>
        {confirmation}
      </section>
      <DraftLeaveConfirmation
        description="Edits in the Playground will be lost if you leave without saving."
        hasDraft={dirty}
        saving={busy}
        submitting={submitting}
        title="Leave without saving?"
      />

      {error ? (
        <div
          className="border-border border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className="astryx-playground-notice border-border border-b bg-emerald-50 px-6 py-2 text-emerald-700 text-sm"
          role="status"
        >
          {notice}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto px-6 py-4 lg:grid-cols-2">
        <fieldset
          className="min-w-0 space-y-3"
          aria-label="Component editor"
          disabled={busy}
        >
          <div className="grid gap-2 md:grid-cols-2">
            <TextField
              label="Name"
              onChange={set("slug")}
              placeholder="refund_card"
              value={draft.slug}
            />
            <TextField
              label="Title"
              onChange={set("title")}
              placeholder="Refund card"
              value={draft.title}
            />
          </div>
          <TextField
            label="What the model is told about it"
            onChange={set("description")}
            placeholder="Show a refund with its amount, reason and status."
            value={draft.description}
          />
          <CodeField label="HTML" onChange={set("html")} value={draft.html} />
          <CodeField label="CSS" onChange={set("css")} value={draft.css} />
          <CodeField
            label="JavaScript"
            onChange={set("jsFunctions")}
            value={draft.jsFunctions}
          />
          <CodeField
            error={
              !validation.ok ? validation.fields.argumentSchema : undefined
            }
            label="Arguments (JSON Schema)"
            onChange={set("argumentSchema")}
            value={draft.argumentSchema}
          />
          <CodeField
            error={
              !validation.ok ? validation.fields.sampleArguments : undefined
            }
            label="Sample arguments"
            onChange={set("sampleArguments")}
            value={draft.sampleArguments}
          />
        </fieldset>

        <div className="space-y-4">
          <SandboxHost
            action={
              <Button
                className="confirmation-action"
                onClick={() => editorHeading.current?.focus()}
                size="sm"
                type="button"
                variant="ghost"
              >
                Back to editor
              </Button>
            }
            headingLevel={2}
            ref={previewHeading}
            status={
              sample === null
                ? {
                    kind: "error",
                    message: "This preview can't be drawn.",
                    description: validation.ok
                      ? "The sample arguments aren't available."
                      : (validation.fields.sampleArguments ??
                        "Fix the JSON fields before previewing."),
                  }
                : undefined
            }
            tabIndex={-1}
            title="Preview"
          >
            <OpenGenerativeUIActivityRenderer
              activityType="open-generative-ui"
              agent={null}
              content={{
                css: draft.css,
                cssComplete: true,
                html: [draft.html],
                htmlComplete: true,
                // Provide sample args in the same sandbox evaluation as the component code.
                jsFunctions: `window.__args = ${JSON.stringify(sample)};\n${draft.jsFunctions}`,
                jsFunctionsComplete: true,
                generating: false,
              }}
              key={`${draft.html}${draft.css}${draft.jsFunctions}${draft.sampleArguments}`}
              message={null}
            />
          </SandboxHost>

          <div className="rounded-lg border border-border bg-card">
            <h2
              className="border-border border-b px-4 py-2 font-medium text-sm"
              id="playground-saved"
              ref={savedHeading}
              tabIndex={-1}
            >
              Saved here
            </h2>
            {/* A failed read is not "nothing saved": your drafts exist, the list just
                couldn't be loaded. */}
            {savedList.error ? (
              <section className="px-4 py-3">
                <ReadError
                  focusAfterRetry={() => savedHeading.current}
                  message="Couldn't load what's saved here."
                  retry={() => savedList.refetch()}
                  retryBelow
                  retryLabel="Retry saved components"
                  retrying={savedList.isFetching}
                />
              </section>
            ) : savedList.isPending ? (
              <section className="px-4 py-3">
                <ReadStatus
                  kind="loading"
                  message="Loading saved components…"
                />
              </section>
            ) : (components ?? []).length === 0 ? (
              <p className="px-4 py-3 text-muted-foreground text-sm">
                Nothing saved yet. Save a draft to see it here.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {(components ?? []).map((component) => (
                  <li
                    className="flex items-center justify-between px-4 py-2 text-sm"
                    style={{ flexWrap: "wrap", gap: "var(--spacing-2)" }}
                    key={component.name}
                  >
                    <div style={{ minInlineSize: 0, overflowWrap: "anywhere" }}>
                      <p>{component.title}</p>
                      <div className="font-mono text-xs">{component.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {component.published
                          ? `published, revision ${component.revision}`
                          : "draft only, no Bot can draw it"}
                        {component.hasUnpublishedChanges
                          ? " · edited since publishing"
                          : ""}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        aria-label={`Open ${component.title}`}
                        className="min-h-11"
                        disabled={busy}
                        onClick={(event) =>
                          open(component, event.currentTarget)
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Open
                      </Button>
                      <Button
                        aria-label={`Delete ${component.title}`}
                        className="min-h-11"
                        disabled={busy}
                        onClick={(event) =>
                          remove(component, event.currentTarget)
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-border border-t px-4 py-2 text-muted-foreground text-xs">
              Publishing makes it available to every Bot. Turn it off for one
              Bot on the UI components page.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  /*
   * An explicit `htmlFor`, not a wrapping label. The label used to wrap a bare `<input>`; now that
   * the control is a component the association has to be written down rather than implied by
   * nesting, or it exists for sighted people only.
   */
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </Field>
  );
}

function CodeField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={Boolean(error)}
        className="h-32 font-mono text-xs"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        value={value}
      />
      {error ? (
        <FieldDescription className="text-destructive" id={`${id}-error`}>
          {error}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
