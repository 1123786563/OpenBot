# P14 Publish Dialog Save-Error Focus Repair

- Parent: B1 T05/P14 and verification-plan B1-E/B1-I.
- Finding: a controlled 503 from the exact publication PUT retains the Audience dialog and shows an error, but browser focus falls to BODY and Escape cannot close it. The request is intercepted and no publication is written.
- Goal: after rejected publish/update, return keyboard focus to a meaningful dialog control so correction/dismissal works.
- Scope: `app/src/components/bot-profile/sharing.tsx` and focused regression `app/tests/bot-sharing.test.tsx`; evidence/report artifacts permitted. No shared Dialog or server changes.
- Constraint: preserve all existing dirty changes. No commit, external publication, dependency install, or OCR.
- Task owner `frontend_implementer`; independent `frontend_validator` and `reviewer`; serial.
- PRE source byte copy/hash: `.archive/runs/2026-10-20-workspace-redesign-b1/verification/b1-share-failure/checkpoints/PRE/`.

## Task 1

Add a ref to the Audience Select trigger and focus it on publish mutation error via `onError`/animation frame. Keep audience/email/group draft, error rendering, mutation payload, and onSuccess close intact. Validate with focused source/test coverage if available, scoped Biome, TypeScript, diff check. A browser validator must intercept exact `PUT /api/team-bots/<fixture>/publication` with 503 at 390×844 light/dark, confirm input state/error, editor focus, Escape closure/focus restore and zero API writes.

## Task 2/3

Independent validation and review use final hashes and only write their reports. Review separately judges B1-E spec coverage and quality; verify unsuccessful update retains audience/typed recipients and successful behavior is unchanged. No OCR.
