# T01 browser environment preflight

- Date: 2026-10-20 (Asia/Shanghai)
- Runner: `bunx e2e run --config docs/verification/workspace-redesign/t01/browser-probe.config.ts --no-cache`
- Exit: 0; 1 browser test executed on Chromium 153.0.8010.12.
- Report: `browser-probe-output/report.json`, run `01a15989-b06a-7aa7-a92d-7a1ff15728c4`.
- Target: configured local app origin `http://localhost:3011`.
- Observed final document: `http://localhost:8000/login/oauth/authorize` (query omitted), title `Built-in Organization`, Casdoor sign-in form. The document is served by the identity provider, not the OpenBot app shell.
- Computed page background/foreground: `rgb(255, 255, 255)` / `rgb(23, 23, 23)`. The expected `--ob-accent`, `--ob-muted`, and `--ob-field` variables were absent on this identity-provider document. No dialog or portal was present.
- Safety: no credentials, cookies, fixture writes, or business actions were used. The probe used a fresh headless browser context and performed only a GET navigation. The OAuth query string is intentionally omitted from this record.

## Ruling

The run proves that a real browser is available and the local app origin redirects unauthenticated users to Casdoor. It does **not** render the OpenBot workspace, so it cannot satisfy T01's theme/portal acceptance or any P01–P23 page acceptance. T01 remains blocked pending a safe authenticated test identity/session and data source or a confirmed isolated test deployment. The successful runner exit is only a successful environment probe, not product acceptance.
