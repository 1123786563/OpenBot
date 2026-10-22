import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

export default {
  projectId: "openbot-workspace-redesign-t01-probe",
  tests: ["browser-probe.e2e.ts"],
  retries: 0,
  workers: 1,
  targets: [{ engine: web(), app: { url: "http://localhost:3011" } }],
  output: "browser-probe-output",
} satisfies E2EConfig;
