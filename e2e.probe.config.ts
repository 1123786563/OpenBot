import type { E2EConfig } from "e2e";
export default {
  projectId: "openbot-probe",
  tests: [process.env.PROBE_FILE ?? "server/tests/config.test.ts"],
  targets: [{ name: "node", platform: "node" }],
  output: ".e2e/probe",
} satisfies E2EConfig;
