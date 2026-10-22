# T05 P15 Error-State Focus — Implementation Report

## Changed files

- `app/src/components/bot-profile/setup.tsx` — retain a ref to the text editor and refocus it on the next animation frame when a save rejects. Successful save and validation semantics are unchanged.
- `app/tests/bot-setup.test.tsx` — add a rejected-PATCH regression that checks the alert and retained draft, input focus, Escape dismissal, return focus to the Title row, and zero recorded profile updates. The route fixture accepts a synthetic rejection flag.

## RED / GREEN evidence

- PRE snapshot was verified before edits: `setup.tsx` SHA-256 `9ebfec43eba5b2eef0c39667674109238ab522032a8c65762487cd10ad5f1c49`; `bot-setup.test.tsx` SHA-256 `ffd8ff923883c499d1e918d43167f08458318ccad6b391ec4d10e26b5ee01aab`; PRE HEAD `203d0f0244b2f898218fa12027089c631e8448d9`.
- RED: `bun test ./app/tests/bot-setup.test.tsx` — 3 pass, new regression failed because `document.activeElement` was not the retained input after rejection.
- GREEN: `bun test ./app/tests/bot-setup.test.tsx` — 4 pass, 0 fail; regression confirms alert/value/focus/Escape/trigger focus and `updates.length === 0`.
- Prescribed `bunx e2e run --config e2e.unit.config.ts app/tests/bot-setup.test.tsx` — unable to collect; `NO_TESTS`, because `docs/verification/e2e-bun-suites.json` routes this exact suite through the Bun driver and `e2e.unit.config.ts` explicitly excludes it. No runner config or manifest edits were made.

## Scoped checks

- `bunx biome check app/src/components/bot-profile/setup.tsx app/tests/bot-setup.test.tsx` — passed after formatting.
- `git diff --check -- app/src/components/bot-profile/setup.tsx app/tests/bot-setup.test.tsx` — passed.

## POST hashes

- `app/src/components/bot-profile/setup.tsx`: `0d8d50a97ce89f8eb4ba802cbf28d6100cba3965cee0b5c964e3b75c992f4fe0`
- `app/tests/bot-setup.test.tsx`: `46667d593fd4c5cb9a31c66b9634c0b6e9085f63c8abf183988c412f88239dd4`

## Limitations

The focused E2E-config command is blocked by the existing driven-suite exclusion; native Bun execution passes. Existing React Aria/HeroUI fixture warnings (missing visible labels and a PressResponder warning) were present during the focused test. No successful API mutation occurred.

## Follow-up — typed editor refs

Validator follow-up found that a union ref could not satisfy either HeroUI-backed input component's narrower ref type. Applied a P15-scoped typing correction: distinct `HTMLInputElement` and `HTMLTextAreaElement` refs, with one error-path focus callback selecting whichever editor is mounted. No test source changes were required; the existing behavior regression covers the input path and prior focus behavior remains intact.

- **RED evidence:** Before the correction, `bunx tsc --noEmit -p app/tsconfig.json` failed with TS2322 at `setup.tsx:284` (textarea ref) and `setup.tsx:293` (input ref): `RefObject<HTMLInputElement | HTMLTextAreaElement | null>` was not assignable to either narrow ref.
- **GREEN evidence:** After correction, `bun test ./app/tests/bot-setup.test.tsx` — 4 passed, 0 failed; `bunx biome check app/src/components/bot-profile/setup.tsx app/tests/bot-setup.test.tsx` — passed; `bunx tsc --noEmit -p app/tsconfig.json` — passed; `git diff --check -- app/src/components/bot-profile/setup.tsx app/tests/bot-setup.test.tsx` — passed.
- **Incremental source diff from prior implementation checkpoint** (`setup.tsx` SHA-256 `0d8d50a97ce89f8eb4ba802cbf28d6100cba3965cee0b5c964e3b75c992f4fe0`):

  ```diff
  -  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  +  const inputRef = useRef<HTMLInputElement>(null);
  +  const textareaRef = useRef<HTMLTextAreaElement>(null);
  ...
  -      requestAnimationFrame(() => fieldRef.current?.focus());
  +      requestAnimationFrame(() => {
  +        (inputRef.current ?? textareaRef.current)?.focus();
  +      });
  ...
  -              ref={fieldRef} // Textarea
  +              ref={textareaRef}
  ...
  -              ref={fieldRef} // Input
  +              ref={inputRef}
  ```

- **Updated POST hashes:** `setup.tsx` `52319fee3fda9c9e916e3e0bf93b3d38947b549569d01d2a66a7a77d9b979b86`; `bot-setup.test.tsx` remains `46667d593fd4c5cb9a31c66b9634c0b6e9085f63c8abf183988c412f88239dd4`.
