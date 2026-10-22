# T05 P15 Role Description Textarea Regression Coverage

## Scope and result

Added a Role description rejected-save regression to `app/tests/bot-setup.test.tsx`. It drives the Role editor's textarea, attempts a controlled rejected save, and verifies that the alert and draft remain, focus stays on the textarea, Escape dismisses the dialog and restores focus to its trigger, and the update store remains untouched.

No product source was changed. The source SHA supplied in the brief was already present and its `catch` path already focuses `(inputRef.current ?? textareaRef.current)`, so the textarea regression passed immediately when run against the assigned source. A genuine behavioral RED could not be produced without changing this prohibited product source; the invalid initial test lookup was corrected and is not counted as RED evidence.

## Checkpoint hashes

- PRE test: `46667d593fd4c5cb9a31c66b9634c0b6e9085f63c8abf183988c412f88239dd4`
- POST test: `c733dccc4b875e212e94b333e65aadf968a9fafc96d3307a1a0d38402bdc308b`
- Source (unchanged): `52319fee3fda9c9e916e3e0bf93b3d38947b549569d01d2a66a7a77d9b979b86`
- PRE snapshot and its hash: `docs/verification/workspace-redesign/p15-error-focus/checkpoints/textarea/PRE/bot-setup.test.tsx`, `PRE/hashes.txt`
- Pre-existing test-file diff from HEAD was captured at `PRE/pre-existing.diff`; this task's incremental diff is exactly the added test below.

## Actual task increment

```diff
+test("a rejected role description edit keeps the textarea focused and its draft", async () => {
+  serve(MANAGED, actor.id, true);
+  const view = draw();
+  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
+  const trigger = await view.findByRole("button", {
+    name: /^Role/,
+  });
+  await user.click(trigger);
+  const field = (await view.findByRole("textbox", {
+    name: "Role",
+  })) as HTMLTextAreaElement;
+  await user.type(field, " Include approval limits.");
+  await user.click(view.getByRole("button", { name: "Save" }));
+  expect(await view.findByRole("alert")).toBeTruthy();
+  expect(field.value).toBe("Review receipts. Include approval limits.");
+  expect(field.ownerDocument.activeElement).toBe(field);
+  await user.keyboard("{Escape}");
+  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
+  expect(field.ownerDocument.activeElement).toBe(trigger);
+  expect(updates).toHaveLength(0);
+});
```

## Verification

- `cd app && bun test ./tests/bot-setup.test.tsx` — PASS, 5 pass / 0 fail, 20 assertions. This working-directory form confines discovery to the requested single file.
- `bunx biome check app/tests/bot-setup.test.tsx` — PASS, one file checked, no fixes applied.
- `git diff --check -- app/tests/bot-setup.test.tsx` — PASS.
- The brief's root-directory form `bun test app/tests/bot-setup.test.tsx` did execute the target (5 target tests passed), but also auto-discovered two saved `.tsx` checkpoint copies under `docs/verification/.../execution/checkpoints/t05/{PRE,POST}` and failed collection because those evidence copies cannot resolve `react/jsx-dev-runtime`. The ADR-compliant app-directory invocation above avoids those unrelated checkpoint files.
- An initial RED attempt used `Role description` as the accessible name; it failed to locate the trigger because the repository's `agents.fields.role` translation is `Role`. The selector was corrected before the passing run. This is a test selector correction, not a product regression.

## Remaining limitation

The current assigned source already implements both input and textarea focus restoration. Therefore this test verifies the textarea path and regression behavior but does not demonstrate a source RED/GREEN transition. No browser-level check was part of this test-only brief.
