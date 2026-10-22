# T05 P14 Error-Focus Implementation Report

- **Change:** PublishDialog stores a ref to its Audience Select trigger and focuses that trigger on mutation error in the next animation frame. Successful `onSuccess: onClose`, submitted values, and visibility policy are unchanged.
- **Test:** `bot-sharing.test.tsx` now checks a rejected PUT retains people/group draft, error, open dialog, and exactly one attempt. Existing specific-audience payload and success behavior coverage remains.
- **Browser:** exact publication PUT intercepted as synthetic 503, light/dark at 390×844 DPR 1; trigger regained focus, Escape closed, focus returned to invoking control, no overflow, zero API publication writes. See `docs/verification/workspace-redesign/b1-share-failure/browser-validation.json`.
- **Validation:** focused Bun suite 8/8, 26 assertions; scoped Biome pass; app TypeScript pass; diff check pass.
- **Hashes:** source `389f96db1fe063c2e9ad2c9bc5de7e78d8f56731d1ab67e1c7b24ebb5feee6d5`; test `88c1779886fdfaf9397c1ce67a583f72b4a7c35c76045dff10afaee302a309fd`.
