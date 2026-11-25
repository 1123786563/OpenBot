# Ticket 156 implementation evidence

Base: `60f966dfaa35d72dcd98a3d4832d5ebb60170a31` (confirmed equal to local parent integration ref).

Standing instructions and custom AI summary rows now wrap without line clamps. Each regression was observed failing against the original presentation and passing after the change. Pointer locale selection was reproduced in Chromium with focus on `main`; after the change both en → zh-CN and zh-CN → en leave focus on the locale combobox. The component test also asserts focus, but Happy DOM alone did not reproduce the native popover focus loss.

Validation: 101 tests passed across the nine i18n/general/AI settings suites, using the repository-root prescribed Bun command. Existing English assertions were preserved. App TypeScript check passed after correcting a nullable test expectation. Dependencies were installed with the frozen lockfile; private `.env.test` is linked from the primary checkout.

Browser coverage in this run is PARTIAL: General settings was checked at 1280 and 360 widths, light and dark media preferences, English and Simplified Chinese (8 combinations). Each combination selected the locale with pointer input, pressed Tab, checked translated title/document lang and absence of document horizontal overflow, and saved a screenshot. This does not establish that the complete page has no clipped text, nor that the application followed the media preference if a persisted theme overrides it.

Not completed: isolated login → navigation → settings flow, all dialog keyboard flows in all eight combinations, real long-content and desktop AI browser fixtures, accessibility audit, and English-baseline wider suite/build. Existing authenticated browser session was used without modifying account content. No save or sign-out was performed.

Missing-key experiment: temporarily removed the Chinese Dark theme resource and restored it. The imperative runtime returned `Dark theme`, but the page DOM check did not observe that fallback before restoration; this is NOT accepted browser fallback evidence. The on-disk Chinese catalog is restored unchanged.

Ticket 156 remains open; this report does not claim full acceptance. The existing PR body contains terminology, Astryx audit, and intentionally retained English inventory; these were read but not independently re-audited in this run. No PR changes, push, ready transition, or watch was performed.
