# P11 Rejected Rule Save: Initial Browser Finding

- **Date:** 2026-10-21.
- **Route:** `/bots/agent_023d30c3-2e68-4bd4-a4ab-e2bba67c9fcc/approvals` in the isolated admin test context.
- **Viewport/theme:** 390×844, light theme.
- **Method:** Playwright Chromium against loopback Vite/API and the disposable tmpfs Postgres database; exact `POST /api/approvals/rules` intercepted and answered with synthetic HTTP 400 (`{"error":"controlled rules failure"}`).
- **Observed:** typed rule remained visible and error alert appeared. `document.activeElement` was `BODY`; Escape left the single Add a rule dialog open. Clicking Cancel closed it and returned focus to the Add a rule trigger. Exactly one POST was intercepted; none reached API and no rule was written.
- **Diagnostic:** `rules-error-focus-diagnostic.json`.
- **Screenshot:** `../b1-approval-rule-failure/light-390x844-error.png`.
- **Baseline source SHA-256:** `9b9f609b87cfb89ec1da5fa214fd237a4d36c6408d5411b565a483413b99902b`.
- **Baseline focused test SHA-256:** `26adaea0623dd50a662f89e3dbc7b944670274e38b8c7ee69c3b4cf3e6dcfffa`.
