import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Collector-only stand-ins for the runner module, so a whole repository's suites can be imported
 * in one process to find out which files fail to load, without paying a runner start-up per pass.
 */
export const registrations = [];

const noop = () => {};

function expectation() {
  const chain = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "not") return chain;
        if (key === "resolves" || key === "rejects") return chain;
        return noop;
      },
    },
  );
  return chain;
}

export const expect = Object.assign(() => expectation(), {
  any: noop,
  anything: noop,
  arrayContaining: noop,
  objectContaining: noop,
  stringContaining: noop,
  stringMatching: noop,
  soft: () => expectation(),
  fail: noop,
  extend: noop,
});

function register(kind) {
  return (title, second, third) => {
    registrations.push({
      kind,
      title: String(title),
      options: second,
      fn: third ?? second,
    });
    return { title };
  };
}

const testFn = register("test");
Object.assign(testFn, {
  skip: Object.assign(register("skip"), {
    each: (table) => () => table.forEach(() => register("skip")),
  }),
  only: register("only"),
  todo: noop,
  each: () => (title, second, third) => register("test")(title, second, third),
  concurrent: testFn,
  sequential: testFn,
  fails: testFn,
  skipIf: () => testFn,
  runIf: () => testFn,
});

const describeFn = register("describe");
Object.assign(describeFn, {
  skip: describeFn,
  only: describeFn,
  concurrent: describeFn,
  serial: describeFn,
  each: () => (title, body) =>
    body && typeof body === "function" ? describeFn(title, body) : noop,
});

export { testFn as test, describeFn as describe };
export const it = testFn;
export const beforeEach = noop;
export const afterEach = noop;
export const beforeAll = noop;
export const afterAll = noop;
export const credentials = {
  user: () => ({ username: "", password: async () => "" }),
};
export const secrets = { get: () => "" };
export const unique = (value) => String(value);

/** Resolve what the runner's own resolver would: extensionless TS files and directory indexes. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "e2e") {
    // This module is both the hook and the stand-in runner: its own exports are the stub.
    return { url: import.meta.url, shortCircuit: true };
  }
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const base = dirname(fileURLToPath(context.parentURL));
    const target = join(base, specifier);
    for (const candidate of [
      `${target}.ts`,
      `${target}.tsx`,
      `${target}/index.ts`,
      target,
    ]) {
      if (existsSync(candidate) && !candidate.endsWith("/")) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
