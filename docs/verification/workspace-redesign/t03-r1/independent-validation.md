# T03-R1 Independent Validation

- Revision: `203d0f0244b2f898218fa12027089c631e8448d9`
- Exact increment: `docs/verification/workspace-redesign/execution/checkpoints/t03-r1/delta.patch`
- Expected patch SHA-256: `96ae5928a597c79821f6e9addc0ce9097625a2fbbfbd86c718263ac9af68725d`
- Result: **PASS for requested source/test-level behavior contracts; browser validation deferred per brief.**

## Integrity

Command: `shasum -a 256 docs/verification/workspace-redesign/execution/checkpoints/t03-r1/delta.patch`

Result: `96ae5928a597c79821f6e9addc0ce9097625a2fbbfbd86c718263ac9af68725d`, matching the brief.

Command: Python independently loaded the PRE/POST manifests, SHA-256 hashed each manifest, and hashed/byte-counted every live file listed in POST.

Results:

- PRE manifest: `8dde8dc428eb4f297f196488de666fa3f0ba808988b084fbf483d761a7bae904`, 14 entries.
- POST manifest: `374a2d3b2239fa87f556f0d150f2e1e97e86474065a9608c11c7fa74cdb9dd60`, 14 entries.
- All 14 live files match POST SHA-256 and byte counts; no mismatches.
- The PRE/POST manifest hashes match their recorded `PRE-hash.txt` and `POST-hash.txt` values.

## Test execution

Exact command:

```sh
bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx app/tests/sidebar-preference.test.ts app/tests/sidebar-shortcut-layouts.test.tsx
```

Exit: `0`. Result: 3 test files passed; 13 tests passed; 0 failed. The runner selected the Node target. `detail-panel.test.tsx` emitted existing React Aria `PressResponder was rendered without a pressable child` stderr warnings during several cases; tests still passed.

No driven-runner validation was needed: the requested command completed the exact three native test files successfully under the ADR0008 unit config.

## Behavior contract inspection

- Shell widths: app shell passes `280px`; admin and settings pass `256px`; `SidebarShell` applies the requested width via `--sidebar-width` and sets the mobile width to `min(280px, calc(100vw - 32px))`.
- Sidebar preference writes: source computes responsive effective state separately from saved state and routes primitive changes through `handleOpenChange`. `detail-panel.test.tsx` covers responsive preservation, explicit toggles, and mobile sheet state; `sidebar-preference.test.ts` covers initial stored values; keyboard shortcut tests cover Ctrl+B/Cmd+B behavior including alternate script layouts. All corresponding tests passed.
- Delayed Craft query seed after remount: `scheduled-task-editor.tsx` suppresses draft publication while the query seed is pending (`seeded` guard), and the test `editing task does not publish pending empty form and seeds after a breakpoint remount` passed within the 6 passing DetailPanel tests.
- DetailPanel draft close/unmount: source invokes caller close handling and conditionally renders detail work only while open. Tests cover narrow close invoking owner/unmount, preserving caller-owned draft across breakpoint changes, and the successful remount seed case. All passed.

## Scope and gaps

This was source/test-level validation only, as explicitly required. No browser, accessibility-tree, or responsive browser checks were performed because the brief says browser checks were deferred. No source or test files were changed. The working tree contains extensive unrelated pre-existing modifications; report is the only file written by this validation task.
