/**
 * F5E1 — boot the unmodified OpenBot server and install ONE documented wiring seam.
 *
 * Why this file exists (finding F5E1-F1, see the report): the built-in Bot's
 * model-span and tool-step observation rides `copilot.ts`'s metered model wrapper
 * (`withUsageMeter`). That wrapper is created only when a model usage meter or a
 * model usage gate is wired, and `index.ts` wires the GATE only when billing is
 * configured. A billing-less deployment therefore produces ZERO observation facts
 * from real built-in runs — silently, by design (`scope === undefined → return`).
 *
 * `setModelUsageMeter` is the seam `copilot.ts` documents for exactly this case
 * ("tests, e2e, and a deployment that meters without gating"). This launcher adds
 * that sink and nothing else: no production module is modified, no observation,
 * binding or export behavior is touched, and the meter itself only echoes the
 * usage it is handed.
 *
 * Run from the worktree's server/ directory so `--env-file` points at the
 * deployment env, then start `real-chain.ts` against the same server URL.
 */
await import("../../server/src/index.ts");
const copilot = await import("../../server/src/copilot.ts");
copilot.setModelUsageMeter((usage: unknown) => {
  // Observers only: the usage is echoed so the evidence log carries the same
  // numbers the model span is built from. Never printed as a secret (it is not).
  console.log("[f5e1-meter]", JSON.stringify(usage).slice(0, 400));
});
console.log(
  "[f5e1-meter] usage meter seam installed (billing-less observation wrapper)",
);
