import { inspect } from "node:util";
/*
 * `node:module` hooks exist only on Node. This layer is loaded there by the e2e runner, but a
 * bun-driven suite can still reach it dynamically (SRA009's driver imports the native-tier
 * `tool-selection.integration.test.ts` inside a `bun test` child to exercise the real fixture
 * lifecycle) — and Bun's `node:module` has no `registerHooks` export, which used to abort that
 * import with a SyntaxError. Resolved lazily instead: on Bun the value layer alone loads, and
 * `installMockHooks` no-ops (bun:test's own mock registry is the one that runs there).
 */
let registerHooks: typeof import("node:module").registerHooks | undefined;
try {
  ({ registerHooks } = await import("node:module"));
} catch {
  // Not just Bun: any runtime without the hooks API keeps the value-only layer.
}
// Installed as a side effect: suites that probe the app the Bun way keep working on Node's runtime.
import "./bun-compat";
import {
  afterAll as nodeAfterAll,
  afterEach as nodeAfterEach,
  beforeAll as nodeBeforeAll,
  beforeEach as nodeBeforeEach,
  describe as nodeDescribe,
  expect as e2eExpect,
  test as nodeTest,
} from "e2e";

/*
 * Under the e2e runner the registration APIs come from the runner itself. A `bun test` process
 * can still load this layer (SRA009's driver imports a native-tier suite file to exercise the
 * real fixture lifecycle), and there the runner's registry has no collector — its test/describe/
 * hook calls throw COLLECTION_ERROR on sight. On Bun they fall back to bun:test, whose registry
 * IS the live one in that process; the value layer (expect and its matchers) is runner-free and
 * stays shared so assertions mean the same thing in both processes.
 */
const bunTestApi = process.versions.bun
  ? ((await import("bun:test")) as Any)
  : null;
const e2eAfterAll = (bunTestApi?.afterAll ??
  nodeAfterAll) as typeof nodeAfterAll;
const e2eAfterEach = (bunTestApi?.afterEach ??
  nodeAfterEach) as typeof nodeAfterEach;
const e2eBeforeAll = (bunTestApi?.beforeAll ??
  nodeBeforeAll) as typeof nodeBeforeAll;
const e2eBeforeEach = (bunTestApi?.beforeEach ??
  nodeBeforeEach) as typeof nodeBeforeEach;
const e2eDescribe = (bunTestApi?.describe ??
  nodeDescribe) as typeof nodeDescribe;
const e2eTest = (bunTestApi?.test ?? nodeTest) as typeof nodeTest;

/*
 * Value-level compatibility layer for the tester-army `e2e` runner.
 *
 * e2e supplies the runner, collection, hooks, locators and the value matchers, and leaves out
 * the unit-runner matchers (`toThrow`, `rejects`, `resolves`, `toBeInstanceOf`, mock-call
 * assertions), `test.each`, and Bun's spies. This module re-adds exactly those and forwards
 * everything else untouched, so a suite keeps one import line.
 */

type Any = any;

const DELEGATED = new Set([
  "toBe",
  "toBeCloseTo",
  "toContain",
  "toBeDefined",
  "toBeFalsy",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeNull",
  "toBeTruthy",
  "toBeUndefined",
  "toEqual",
  "toHaveLength",
  "toHaveProperty",
  "toMatch",
  "toMatchObject",
  "toMatchSchema",
]);

const ADDED = new Set([
  "toThrow",
  "toThrowError",
  "toBeInstanceOf",
  "toContainEqual",
  "toStartWith",
  "toEndWith",
  "toBeTrue",
  "toBeFalse",
  "toBeString",
  "toBeNumber",
  "toBeBoolean",
  "toBeArray",
  "toBeFunction",
  "toBeObject",
  "toBeTypeOf",
  "toBeArrayOfSize",
  "toBeNaN",
  "toHaveBeenCalled",
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
]);

/** Bun's type predicates, which the end-to-end matcher set has no reason to carry. */
const TYPES: Record<string, (value: Any) => boolean> = {
  toBeTrue: (value) => value === true,
  toBeFalse: (value) => value === false,
  toBeString: (value) => typeof value === "string",
  toBeNumber: (value) => typeof value === "number" && !Number.isNaN(value),
  toBeNaN: (value) => typeof value === "number" && Number.isNaN(value),
  toBeBoolean: (value) => typeof value === "boolean",
  toBeArray: (value) => Array.isArray(value),
  toBeFunction: (value) => typeof value === "function",
  toBeObject: (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
};

function show(value: unknown): string {
  try {
    return inspect(value, { depth: 3, breakLength: 120 });
  } catch {
    return String(value);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchesError(error: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  const message = messageOf(error);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "function") {
    // A class means instance-of; an arrow function is a predicate, as in Jest.
    if (expected.prototype !== undefined)
      return error instanceof (expected as Any);
    return Boolean((expected as (caught: unknown) => unknown)(error));
  }
  if (expected && typeof expected === "object" && "message" in expected) {
    return message.includes(String((expected as { message: unknown }).message));
  }
  return false;
}

function callsE2e(
  actual: Any,
  matcher: string,
  args: unknown[],
  negate: boolean,
  label: string,
  message?: string,
): void {
  if (!DELEGATED.has(matcher)) {
    throw new Error(
      `expect(...).${label}${matcher}() is not a matcher of this runner`,
    );
  }
  const base: Any = negate
    ? e2eExpect(actual, message).not
    : e2eExpect(actual, message);
  base[matcher](...args);
}

function check(
  name: string,
  ok: boolean,
  negate: boolean,
  detail: string,
): void {
  if (ok === !negate) return;
  throw new Error(
    `expect(...).${negate ? "not." : ""}${name} failed: ${detail}`,
  );
}

function expectThrow(
  actual: Any,
  expected: unknown,
  negate: boolean,
  name: string,
): void {
  if (typeof actual !== "function") {
    throw new Error(
      `expect(...).${name}() needs a function, got ${show(actual)}`,
    );
  }
  let threw = false;
  let caught: unknown;
  try {
    const returned = actual() as unknown;
    if (returned && typeof (returned as Promise<unknown>).then === "function") {
      throw new Error(
        `expect(...).${name}() received a promise from the call; await it with expect(...).rejects.${name}()`,
      );
    }
  } catch (error) {
    threw = true;
    caught = error;
  }
  if (
    threw &&
    caught instanceof Error &&
    caught.message.startsWith(`expect(...).${name}() received a promise`)
  ) {
    throw caught;
  }
  if (negate) {
    check(
      name,
      !threw || !matchesError(caught, expected),
      false,
      `threw ${show(caught)}`,
    );
    return;
  }
  check(
    name,
    threw && matchesError(caught, expected),
    false,
    threw ? `threw ${messageOf(caught)}` : "nothing was thrown",
  );
}

function mockCalls(actual: Any, name: string): unknown[][] {
  const calls = actual?.mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(
      `expect(...).${name}() needs a mock function, got ${show(actual)}`,
    );
  }
  return calls;
}

function sameCall(called: unknown[] | undefined, expected: unknown[]): boolean {
  try {
    e2eExpect(called ?? []).toEqual(expected);
    return true;
  } catch {
    return false;
  }
}

function expectAdded(
  name: string,
  actual: Any,
  args: unknown[],
  negate: boolean,
  label: string,
): void {
  switch (name) {
    case "toThrow":
    case "toThrowError":
      expectThrow(actual, args[0], negate, name);
      return;
    case "toBeInstanceOf":
      check(
        name,
        actual instanceof (args[0] as Any),
        negate,
        `${show(actual)}`,
      );
      return;
    case "toContainEqual":
      check(
        name,
        Array.isArray(actual) &&
          actual.some((entry) => sameCall([entry], args)),
        negate,
        `${show(actual)} has no element equal to ${show(args[0])}`,
      );
      return;
    case "toStartWith":
      check(
        name,
        String(actual).startsWith(String(args[0])),
        negate,
        `${show(actual)} does not start with ${show(args[0])}`,
      );
      return;
    case "toEndWith":
      check(
        name,
        String(actual).endsWith(String(args[0])),
        negate,
        `${show(actual)} does not end with ${show(args[0])}`,
      );
      return;
    case "toHaveBeenCalled":
    case "toHaveBeenCalledOnce":
    case "toHaveBeenCalledTimes": {
      const calls = mockCalls(actual, name);
      const expected =
        name === "toHaveBeenCalled"
          ? calls.length > 0
          : name === "toHaveBeenCalledOnce"
            ? calls.length === 1
            : Number(args[0]);
      check(
        name,
        name === "toHaveBeenCalled"
          ? calls.length > 0
          : calls.length === expected,
        negate,
        `called ${calls.length} times`,
      );
      return;
    }
    case "toHaveBeenCalledWith":
      check(
        name,
        mockCalls(actual, name).some((call) => sameCall(call, args)),
        negate,
        `calls ${show(mockCalls(actual, name))}`,
      );
      return;
    case "toHaveBeenLastCalledWith": {
      const calls = mockCalls(actual, name);
      const last = calls[calls.length - 1];
      check(name, sameCall(last, args), negate, `last call ${show(last)}`);
      return;
    }
    case "toHaveBeenNthCalledWith": {
      const calls = mockCalls(actual, name);
      const index = Number(args[0]) - 1;
      check(
        name,
        sameCall(calls[index], args.slice(1)),
        negate,
        `call ${index + 1} ${show(calls[index])}`,
      );
      return;
    }
    case "toBeTypeOf": {
      check(
        name,
        typeof actual === args[0],
        negate,
        `typeof ${show(actual)} is ${typeof actual}, expected ${show(args[0])}`,
      );
      return;
    }
    case "toBeArrayOfSize": {
      const size = Array.isArray(actual) ? actual.length : -1;
      check(
        name,
        size === Number(args[0]),
        negate,
        `length ${size}, expected ${show(args[0])}`,
      );
      return;
    }
    default: {
      const predicate = TYPES[name];
      if (predicate) {
        check(name, predicate(actual), negate, `${show(actual)}`);
        return;
      }
      throw new Error(
        `expect(...).${label}${name}() is not a matcher of this runner`,
      );
    }
  }
}

function applyMatcher(
  name: string,
  actual: Any,
  args: unknown[],
  negate: boolean,
  label: string,
  message?: string,
): void {
  if (ADDED.has(name)) expectAdded(name, actual, args, negate, label);
  else callsE2e(actual, name, args, negate, label, message);
}

/** `.resolves` / `.rejects`: every matcher method returns a promise, so `await` settles it. */
function asyncChain(
  actual: Any,
  kind: "resolves" | "rejects",
  negate: boolean,
  message?: string,
): Any {
  const run = async (name: string, args: unknown[]): Promise<void> => {
    let value: Any;
    if (kind === "resolves") {
      value = await actual;
    } else {
      let rejected = false;
      let caught: unknown;
      try {
        await (typeof actual === "function" ? actual() : actual);
      } catch (error) {
        rejected = true;
        caught = error;
      }
      check(
        "rejects",
        rejected,
        false,
        rejected ? "" : "the promise resolved instead of rejecting",
      );
      if (name === "toThrow" || name === "toThrowError") {
        check(
          name,
          matchesError(caught, args[0]),
          negate,
          `rejected with ${messageOf(caught)}, expected ${show(args[0])}`,
        );
        return;
      }
      value = caught;
    }
    applyMatcher(name, value, args, negate, `${kind}.`, message);
  };
  return new Proxy({} as Any, {
    get: (_target, key: string) => {
      if (key === "not") return asyncChain(actual, kind, !negate, message);
      if (typeof key === "string" && (key === "then" || key === "catch")) {
        return (...args: unknown[]) =>
          Promise.resolve().then(...(args as [Any]));
      }
      return (...args: unknown[]) => run(key, args);
    },
  });
}

function buildExpectation(
  actual: Any,
  negate: boolean,
  label: string,
  message?: string,
): Any {
  return new Proxy({} as Any, {
    get: (_target, key: string) => {
      if (key === "not")
        return buildExpectation(actual, !negate, "not.", message);
      if (key === "resolves") return asyncChain(actual, "resolves", negate);
      if (key === "rejects") return asyncChain(actual, "rejects", negate);
      if (
        typeof key === "symbol" ||
        key === "then" ||
        key === "catch" ||
        key === "inspect"
      )
        return undefined;
      return (...args: unknown[]) => {
        applyMatcher(key, actual, args, negate, label, message);
      };
    },
  });
}

/**
 * Generic so `expect(value).toBe<Kind>(other)` keeps working: e2e's own `expect` has no type
 * parameters and neither does Bun's, but the suites were written against the one that does.
 */
export interface ExpectFn {
  <T = Any>(actual: T, message?: string): SuiteExpectation;
  any: Any;
  anything: () => Any;
  arrayContaining: (sample: readonly unknown[]) => Any;
  objectContaining: (sample: Record<string, unknown>) => Any;
  stringContaining: (text: string) => Any;
  stringMatching: (pattern: string | RegExp) => Any;
  soft: <T = Any>(actual: T, message?: string) => SuiteExpectation;
  fail: (message?: string) => never;
  unreachable: (message?: string) => never;
  /**
   * Left open on purpose: the compat layer grows matchers as suites ask for them, and a test that
   * reaches one first must fail at runtime with a clear message, not silently at type-check time in
   * whichever workspace happens to include it.
   */
  [member: string]: Any;
}

export const expect: ExpectFn = Object.assign(
  <T = Any>(actual: T, message?: string): SuiteExpectation =>
    buildExpectation(actual, false, "", message) as SuiteExpectation,
  {
    any: (e2eExpect as Any).any,
    anything: (e2eExpect as Any).anything,
    arrayContaining: (e2eExpect as Any).arrayContaining,
    objectContaining: (e2eExpect as Any).objectContaining,
    stringContaining: (e2eExpect as Any).stringContaining,
    stringMatching: (e2eExpect as Any).stringMatching,
    soft: (actual: Any, message?: string) =>
      buildExpectation(actual, false, "soft.", message) as SuiteExpectation,
    fail: (message?: string) => {
      throw new Error(message ?? "expect.fail()");
    },
    unreachable: (message?: string) => {
      throw new Error(message ?? "Reached code marked unreachable");
    },
  },
);

/* --------------------------------------------------------------------- spies */

export interface Mock<
  T extends (...args: any[]) => any = (...args: any[]) => any,
> {
  (...args: Parameters<T>): ReturnType<T>;
  mock: {
    calls: any[][];
    results: { type: string; value: unknown }[];
    instances: unknown[];
    lastCall?: any[];
  };
  _isMockFunction: true;
  mockImplementation(next: T): Mock<T>;
  mockReturnValue(value: unknown): Mock;
  mockReturnValueOnce(value: unknown): Mock;
  mockResolvedValue(value: unknown): Mock;
  mockResolvedValueOnce(value: unknown): Mock;
  mockRejectedValue(value: unknown): Mock;
  mockRejectedValueOnce(value: unknown): Mock;
  mockClear(): Mock;
  mockReset(): Mock;
  mockRestore(): void;
  mockName(name: string): Mock;
  /** Bun's module mock: replaces a specifier for every importer that loads it afterwards. */
  module(specifier: string, factory: () => Record<string, unknown>): () => void;
  restore(): void;
  getMockImplementation(): ((...args: any[]) => unknown) | undefined;
}

function makeMock(
  defaultImplementation: (...args: any[]) => unknown,
  restore?: () => void,
): Mock {
  let implementation = defaultImplementation;
  const self = ((...args: any[]) => {
    self.mock.calls.push(args);
    self.mock.lastCall = args;
    const value = implementation(...args);
    self.mock.results.push({ type: "return", value });
    return value;
  }) as Mock;
  self._isMockFunction = true;
  self.mock = { calls: [], results: [], instances: [] };
  self.mockImplementation = (next) => {
    implementation = next;
    return self;
  };
  const once = <T>(value: T) => {
    const previous = implementation;
    let used = false;
    return self.mockImplementation((...args: any[]) => {
      if (used) return previous(...args);
      used = true;
      return value;
    });
  };
  self.mockReturnValue = (value) => self.mockImplementation(() => value);
  self.mockReturnValueOnce = (value) => once(value);
  self.mockResolvedValue = (value) =>
    self.mockReturnValue(Promise.resolve(value));
  self.mockResolvedValueOnce = (value) => once(Promise.resolve(value));
  self.mockRejectedValue = (value) =>
    self.mockReturnValue(Promise.reject(value));
  self.mockRejectedValueOnce = (value) => once(Promise.reject(value));
  self.mockClear = () => {
    self.mock.calls = [];
    self.mock.results = [];
    self.mock.instances = [];
    delete self.mock.lastCall;
    return self;
  };
  self.mockReset = () => {
    self.mockClear();
    implementation = defaultImplementation;
    return self;
  };
  self.mockRestore = () => restore?.();
  self.mockName = () => self;
  self.getMockImplementation = () => implementation;
  return self;
}

export interface MockFactory {
  (implementation?: (...args: any[]) => unknown): Mock;
  module(specifier: string, factory: () => Record<string, unknown>): () => void;
  restore(): void;
}

/* --------------------------------------------------------- module mocking */

const MOCK_REGISTRY = Symbol.for("openbot.e2e-compat.module-mocks");
const mocks: Map<string, unknown[]> = ((globalThis as Any)[MOCK_REGISTRY] ??=
  new Map());
const moduleMocks: Map<string, () => Record<string, unknown>> = new Map();
/*
 * The runner imports a suite file more than once per run (to list it, then to execute it), and a
 * second `module.registerHooks()` call or a second copy of the mock registry would make the two
 * passes disagree about what was registered. Both flags therefore live on globalThis, keyed by
 * symbol, so they survive re-evaluation of this module in the same process.
 */
const HOOKS_INSTALLED = Symbol.for("openbot.e2e-compat.hooks-installed");
const SKIPPING = Symbol.for("openbot.e2e-compat.skipping-depth");

/*
 * `mock.module(specifier, factory)` over Node's loader hooks.
 *
 * The generated module reads the factory's exports back from a process-wide registry, so any
 * specifier can be mocked, including the `@/...` aliases and relative paths `spyOn` cannot reach.
 * Like Bun's it is registry level and outlives the file that set it, which is why suites import the
 * mocked module only after calling it.
 */
function installMockHooks(): void {
  if ((globalThis as Any)[HOOKS_INSTALLED]) return;
  // Without Node's loader hooks (Bun, see the import above) there is nothing to install:
  // bun:test's own registry is already in force in that process.
  if (!registerHooks) return;
  (globalThis as Any)[HOOKS_INSTALLED] = true;
  registerHooks({
    resolve: (specifier: string, _context: Any, nextResolve: Any) => {
      // Stylesheets and other assets: Bun imports them for their side effect, Node has no such
      // format and refuses on the extension, so the specifier never reaches the extension check.
      if (
        /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|ttf|ico)$/i.test(
          specifier,
        )
      ) {
        return {
          url: "data:text/javascript,export%20default%20%22%22;",
          format: "module",
          shortCircuit: true,
        };
      }
      if (specifier === "bun") {
        // A suite the runner imports under Node may import the runtime itself
        // (`import { serve } from "bun"` — agent-computer's server entry does);
        // the shim already installed on globalThis is that module here too.
        return {
          url: "e2e-bun-shim:",
          format: "module",
          shortCircuit: true,
        };
      }
      if (moduleMocks.has(specifier)) {
        return {
          url: `e2e-mock:${encodeURIComponent(specifier)}`,
          format: "module",
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, _context);
    },
    load: (url: string, context: Any, nextLoad: Any) => {
      // Stylesheets and other assets: Bun imports them as a side effect, Node has no such format.
      if (
        /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|ttf|ico)(\?|$)/i.test(
          url,
        )
      ) {
        return {
          format: "module",
          shortCircuit: true,
          source: 'export default "";\n',
        };
      }
      if (url === "e2e-bun-shim:") {
        const members = [
          "serve",
          "spawn",
          "file",
          "write",
          "sleep",
          "which",
          "Glob",
          "exist",
          "rm",
          "mkdir",
          "read",
          "CryptoHasher",
          "YAML",
          "argv",
          "env",
          "version",
        ];
        return {
          format: "module",
          shortCircuit: true,
          source:
            "const Bun = globalThis.Bun;\n" +
            members.map((m) => `export const ${m} = Bun.${m};`).join("\n") +
            "\nexport default Bun;\n",
        };
      }
      if (!url.startsWith("e2e-mock:")) {
        // A suite file re-entering the loader is the start of a fresh collection pass.
        const suite = suiteFileOf(url);
        if (suite) {
          forgetTitlesOf(suite);
          // ...and a realm boundary for module mocks: `mock.module` is registry
          // level, so a suite's mocks must not reach the next suite's imports —
          // one suite mocking "./Problem" used to replace another suite's real
          // import of it and abort the whole run's collection. A fixture that
          // registers mocks at its own top level must therefore be imported by
          // each suite that needs it, not relied on across this boundary.
          moduleMocks.clear();
          mocks.clear();
        }
        const loaded = nextLoad(url, context);
        return loaded;
      }
      const key = decodeURIComponent(url.slice("e2e-mock:".length));
      const names = Object.keys(moduleMocks.get(key)?.() ?? {});
      const body = names
        .map((name, index) =>
          name === "default"
            ? `export default __mocks__[${index}];`
            : `export const ${identifier(name)} = __mocks__[${index}];`,
        )
        .join("\n");
      return {
        format: "module",
        shortCircuit: true,
        source:
          `const __mocks__ = globalThis[Symbol.for("openbot.e2e-compat.module-mocks")].get(` +
          `${JSON.stringify(key)});\n${body}\n`,
      };
    },
  });
}

function identifier(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name)
    ? name
    : `_${Math.abs([...name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7))}`;
}

installMockHooks();

const makeSpy = (implementation?: (...args: any[]) => unknown): Mock =>
  makeMock(implementation ?? (() => undefined));

export const mock: MockFactory = Object.assign(makeSpy, {
  module(
    specifier: string,
    factory: () => Record<string, unknown>,
  ): () => void {
    installMockHooks();
    moduleMocks.set(specifier, factory);
    mocks.set(specifier, Object.values(factory()));
    return () => {
      moduleMocks.delete(specifier);
      mocks.delete(specifier);
    };
  },
  restore(): void {
    moduleMocks.clear();
    mocks.clear();
  },
});

const liveSpies = new Set<Mock>();

export function spyOn(target: Any, key: string | symbol): Mock {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const original = target?.[key];
  if (typeof original !== "function" && !descriptor?.get) {
    throw new Error(`spyOn: ${String(key)} is not a function or a getter`);
  }
  const base = descriptor?.get
    ? () => descriptor.get?.call(target)
    : original.bind(target);
  const spy = makeMock(base, () => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
    liveSpies.delete(spy);
  });
  liveSpies.add(spy);
  if (descriptor?.get)
    Object.defineProperty(target, key, { ...descriptor, get: () => spy });
  else target[key] = spy;
  return spy;
}

/* ---------------------------------------------------------------- fake clock */

interface FakeTimer {
  id: number;
  every: number;
  at: number;
  fn: (...args: unknown[]) => unknown;
  args: unknown[];
  cancelled: boolean;
}

const real = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
  Date: globalThis.Date,
};
let clock = false;
let now = 0;
let nextId = 1;
let timers: FakeTimer[] = [];

class FakeDate extends real.Date {
  constructor(...args: any[]) {
    super(...((args.length === 0 ? [now] : args) as [number]));
  }
  static now(): number {
    return now;
  }
}

/*
 * A hand-pushed clock. Each global is reassigned through `Any` on purpose: Node's and Bun's timer
 * signatures disagree on the handle type, and the point here is the queue, not the overload.
 */
export function useFakeTimers(): void {
  if (clock) return;
  clock = true;
  now = real.Date.now();
  timers = [];
  const schedule = (every: number) =>
    ((
      fn: (...args: unknown[]) => unknown,
      ms: number = 0,
      ...args: unknown[]
    ) => {
      const timer: FakeTimer = {
        id: nextId++,
        every,
        at: now + Number(ms),
        fn,
        args,
        cancelled: false,
      };
      timers.push(timer);
      return timer.id as Any;
    }) as Any;
  globalThis.setTimeout = schedule(0) as Any;
  globalThis.setInterval = schedule(1) as Any;
  const clear = ((id: unknown) => {
    const timer = timers.find((entry) => entry.id === Number(id));
    if (timer) timer.cancelled = true;
  }) as Any;
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  globalThis.Date = FakeDate as Any;
}

export function useRealTimers(): void {
  if (!clock) return;
  clock = false;
  globalThis.setTimeout = real.setTimeout as Any;
  globalThis.setInterval = real.setInterval as Any;
  globalThis.clearTimeout = real.clearTimeout as Any;
  globalThis.clearInterval = real.clearInterval as Any;
  globalThis.Date = real.Date as Any;
  timers = [];
}

export function advanceTimersByTime(ms: number): void {
  const until = now + Number(ms);
  for (let guard = 0; guard < 100_000; guard += 1) {
    const due = timers
      .filter((t) => !t.cancelled && t.at <= until)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    now = due.at;
    if (due.every) due.at = now + (due.every || 1);
    else due.cancelled = true;
    due.fn(...due.args);
  }
  now = until;
}

export function setSystemTime(value?: number | string | Date): void {
  now = value === undefined ? real.Date.now() : new real.Date(value).getTime();
}

export const jest = {
  fn: (implementation?: (...args: any[]) => unknown) => mock(implementation),
  spyOn,
  useFakeTimers,
  useRealTimers,
  advanceTimersByTime,
  advanceTimers: advanceTimersByTime,
  runAllTimers: () => advanceTimersByTime(2_147_483_647),
  setSystemTime,
  restoreAllMocks: () => {
    for (const spy of [...liveSpies]) spy.mockRestore();
  },
  clearAllMocks: () => {
    for (const spy of [...liveSpies]) spy.mockClear();
  },
};

/* --------------------------------------------------------- parameterisation */

function formatToken(flag: string, value: unknown): string {
  switch (flag) {
    case "s":
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    case "d":
    case "i":
      return String(Math.trunc(Number(value)));
    case "f":
      return String(Number(value));
    case "j":
      return JSON.stringify(value);
    case "o":
    case "p":
      return inspect(value, { depth: 2, breakLength: 120 });
    default:
      return String(value);
  }
}

function expand(title: string, args: unknown[], named: Any): string {
  let index = 0;
  const out = title.replace(/%[sdifojp%]/g, (token) =>
    token === "%%" ? "%" : formatToken(token[1], args[index++] ?? named),
  );
  // Bun's formatter appends the arguments a template did not consume, and the suites lean on that:
  // `refuses %s before dispatch` with a row of [label, token, jwt] ends up naming the token too. e2e
  // identifies a test by its title in both of its processes, so a leftover `exp` timestamp or an
  // Error's creation stack (which records how the file was imported) makes the two passes disagree,
  // and the runner reports the row as a test that disappeared. Consumed specifiers only: the label is
  // the title, and the body still receives every argument.
  return out.replace(/\$(\w+)/g, (_m, key: string) =>
    named && typeof named === "object" ? String(named[key]) : `$${key}`,
  );
}

interface Case {
  args: unknown[];
  named: Any;
}

function casesOf(table: readonly unknown[]): Case[] {
  if (Array.isArray(table) && table.every((row) => Array.isArray(row))) {
    return (table as unknown[][]).map((row) => ({
      args: row,
      named: undefined,
    }));
  }
  return (table as Any[]).map((entry) => ({
    args: [entry],
    named:
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry
        : undefined,
  }));
}

/** Bun takes `{ timeout, retry }`; e2e takes `{ timeout, retries, tags, skip, ... }`. */
function translate(options: Any): Any {
  if (!options || typeof options !== "object" || Array.isArray(options))
    return undefined;
  const out: Any = { ...options };
  if ("retry" in out) {
    out.retries = out.retry;
    delete out.retry;
  }
  for (const bunOnly of ["perImport", "TODO", "signal"]) delete out[bunOnly];
  return out;
}

type Body = (...args: any[]) => unknown;
type Register = (...args: any[]) => unknown;

/*
 * e2e names a test by its title path and requires 1..512 UTF-8 bytes, unique inside one file;
 * Bun accepted longer and repeated titles. Titles are report labels, not assertions, so the runner's
 * rule is honoured by clamping and by numbering a repeat, never by dropping the test.
 *
 * The runner imports every suite file more than once (to list it, then to execute it) and requires the
 * two passes to register the same set, so a title has to be a function of the declaration alone:
 *
 *  - the uniqueness domain is the whole title path, so `is on when nothing is set` inside two
 *    different `describe` groups is not a repeat and must not be renumbered;
 *  - the repeat counter is per file and resets when that file enters the loader again, so a second
 *    pass does not hand back `… [2]` for what the first pass called `… [1]`;
 *  - a title must be a function of the declaration, not of data generated at import. Three suites
 *    spelled an Ed25519 JWK or a random id into their `each` titles, so no two imports could agree —
 *    the runner's list pass and execute pass are separate processes — and those fixtures are fixed
 *    values now, because the runner has no channel for a per-run label.
 */
const SEEN_TITLES = Symbol.for("openbot.e2e-compat.seen-titles");
const DESCRIBE_PATH = Symbol.for("openbot.e2e-compat.describe-path");
const seenTitles: Map<string, Map<string, number>> = ((globalThis as Any)[
  SEEN_TITLES
] ??= new Map());
const describePath: string[] = ((globalThis as Any)[DESCRIBE_PATH] ??= []);

function suiteFileOf(url: string): string | null {
  const path = url.split("?")[0];
  const match = path.match(
    /^(?:file:\/\/)?(.*\.(?:test|spec)\.tsx?|.*\.(?:test|spec)\.mts)$/,
  );
  return match ? match[1].replace(/^\//, "") : null;
}

function forgetTitlesOf(file: string): void {
  seenTitles.delete(file);
  describePath.length = 0;
}

function fileFromStack(): string {
  const line = (new Error().stack ?? "")
    .split("\n")
    .find(
      (entry) =>
        /\.test\.tsx?|\.spec\.tsx?/.test(entry) &&
        !entry.includes("e2e-compat"),
    );
  const match = line?.match(/\/((?:[^/\s]+\/)+[^/\s]+\.(?:test|spec)\.tsx?)/);
  return match ? match[1] : "unknown";
}

function clampTitle(title: string, kind: string): string {
  let candidate = title;
  if (Buffer.byteLength(candidate) > 512) {
    while (Buffer.byteLength(candidate) > 500)
      candidate = candidate.slice(0, candidate.length - 8);
    candidate += " …";
  }
  const file = fileFromStack();
  const perFile = seenTitles.get(file) ?? new Map();
  seenTitles.set(file, perFile);
  const key = `${kind}:${describePath.join("›")}:${candidate}`;
  const seen = (perFile.get(key) ?? 0) + 1;
  perFile.set(key, seen);
  if (seen === 1) return candidate;
  const suffix = ` [${seen}]`;
  return candidate.slice(0, 512 - Buffer.byteLength(suffix)) + suffix;
}

/** Registers a group with its title on the path, so the tests inside it are named by their path. */
function withinGroup(name: string, register: () => unknown): unknown {
  describePath.push(name);
  try {
    return register();
  } finally {
    describePath.pop();
  }
}

function registerTest(register: Register) {
  return (title: string, second: Any, third?: Any): unknown => {
    const named = clampTitle(title, "test");
    // Bun's `test(title, fn, timeoutMs)` puts the deadline in a third positional argument.
    if (typeof second === "function" && typeof third === "number") {
      return register(named, { timeout: third }, second);
    }
    if (typeof second === "function") {
      return third === undefined
        ? register(named, second)
        : register(named, translate(third), second);
    }
    const options = translate(second);
    // e2e reads the argument count: a three-argument call whose options are undefined is a collection error.
    return options === undefined
      ? register(named, third)
      : register(named, options, third);
  };
}

function eachOver(register: Register, table: readonly unknown[]) {
  const rows = casesOf(table);
  return (title: string, second: Any, third?: Any) => {
    const make = registerTest(register);
    const options =
      typeof second === "function" ? undefined : translate(second);
    const body = (typeof second === "function" ? second : third) as Body;
    for (const row of rows) {
      const name = expand(title, [...row.args], row.named);
      const wrapped = () => body(...row.args);
      if (options) make(name, options, wrapped);
      else make(name, wrapped);
    }
  };
}

const trace = (label: string, args: unknown[]) => {
  if (!process.env.E2E_COMPAT_DEBUG) return;
  console.error(
    `[e2e-compat] ${label}(${JSON.stringify(String(args[0]))}) arity=${args.length} types=${args
      .map((a) => (Array.isArray(a) ? "array" : typeof a))
      .join(",")}`,
  );
};

const skippingOf = (): number => Number((globalThis as Any)[SKIPPING] ?? 0);
const setSkipping = (value: number): void => {
  (globalThis as Any)[SKIPPING] = value;
};

const e2eRegister: Register = (...args) => {
  trace("test", args);
  const [, second, third] = args;
  const bodyIndex = typeof second === "function" ? 1 : 2;
  const body = bodyIndex === 1 ? second : third;
  const call = [...args];
  if (skippingOf() > 0 && typeof body === "function") {
    // A skipped group stays registered and skips in its body: e2e refuses a file that has collected
    // nothing runnable, which is what registering the whole group as skipped would leave behind.
    call[bodyIndex] = (...callArgs: Any[]) => {
      (e2eTest.skip as Any)(true, "group skipped");
      return body(...callArgs);
    };
  } else if (process.env.E2E_COMPAT_DEBUG && typeof body === "function") {
    // The report and the trace page carry the message only — no stack — which is enough to triage an
    // assertion diff and nowhere near enough for `Cannot read properties of undefined`. Under the
    // debug flag the body is wrapped so the throwing frame reaches stderr.
    call[bodyIndex] = async (...callArgs: Any[]) => {
      try {
        return await body(...callArgs);
      } catch (error) {
        console.error(
          `[e2e-compat] body threw: ${(error as Any)?.stack ?? error}`,
        );
        throw error;
      }
    };
  }
  try {
    return (e2eTest as Any)(...call);
  } catch (error) {
    if (process.env.E2E_COMPAT_DEBUG) console.error((error as Error).stack);
    throw error;
  }
};
const onlyRegister: Register = (title, second, third) =>
  registerTest((...args) => (e2eTest.only as Any)(...args))(
    title,
    second,
    third,
  );
// `test.skip(title, options, fn)` is not a call shape e2e takes: skipping at collection is an option.
const skipRegister: Register = (title, second) => {
  const options = typeof second === "function" ? undefined : translate(second);
  const reason = typeof options?.skip === "string" ? options.skip : "skipped";
  // A runtime skip, not a collection skip: the attempt reports skipped with its reason, and the
  // file still has something runnable, which is what e2e requires of a collected suite file.
  const body = () => (e2eTest.skip as Any)(true, reason);
  return options?.timeout
    ? (e2eTest as Any)(title, { timeout: options.timeout }, body)
    : (e2eTest as Any)(title, body);
};

// Callbacks arrive positionally, so the signature has to leave their parameters `any`:
// a `(title, fn)`-shaped type would give every `each` case body implicit-`any` errors under tsc.
interface RegisterCall {
  (title: string, body: (...args: any[]) => unknown): unknown;
  (title: string, options: object, body: (...args: any[]) => unknown): unknown;
  // Bun's deadline-as-third-argument form, which `test.each` rows use for slow live probes.
  (
    title: string,
    body: (...args: any[]) => unknown,
    timeoutMs: number,
  ): unknown;
}
interface Parameterised extends RegisterCall {
  each: (table: readonly unknown[]) => RegisterCall;
}
interface TestExtras {
  each: (table: readonly unknown[]) => RegisterCall;
  skip: Parameterised;
  only: Parameterised;
  todo: (title: string) => unknown;
  fails: RegisterCall;
  skipIf: (condition: boolean) => RegisterCall;
  runIf: (condition: boolean) => RegisterCall;
  concurrent: RegisterCall;
  sequential: RegisterCall;
}
interface DescribeExtras {
  each: (table: readonly unknown[]) => RegisterCall;
  skip: RegisterCall;
  only: RegisterCall;
  serial: RegisterCall;
  concurrent: RegisterCall;
  skipIf: (condition: boolean) => RegisterCall;
  runIf: (condition: boolean) => RegisterCall;
}

/**
 * The chain an `expect(value)` answers with. Only the matchers the suites pass type arguments to are
 * generic (`expect(x).toBe<ItemPhase>(y)`); the rest take anything, because this layer is where the
 * runner's own matcher set is extended, not where its arguments are re-typed.
 */
export interface SuiteExpectation {
  toBe<T = Any>(expected: T): void;
  toEqual<T = Any>(expected: T): void;
  toThrow<T = Any>(expected?: T): void;
  toBeInstanceOf<T = Any>(expected?: T): void;
  not: SuiteExpectation;
  resolves: SuiteExpectation;
  rejects: SuiteExpectation;
  [matcher: string]: Any;
}

export const test = ((title: string, second: Any, third?: Any) =>
  registerTest(e2eRegister)(title, second, third)) as unknown as TestExtras & {
  (title: string, body: (...args: any[]) => unknown): unknown;
  (title: string, options: object, body: (...args: any[]) => unknown): unknown;
  // Bun's deadline-as-third-argument form, which the suites use for slow live probes.
  (
    title: string,
    body: (...args: any[]) => unknown,
    timeoutMs: number,
  ): unknown;
};

Object.defineProperties(test, {
  each: {
    value: (table: readonly unknown[]) => eachOver(e2eRegister, table),
    configurable: true,
  },
  skip: {
    value: Object.assign(
      (title: Any, second: Any, third?: Any) =>
        typeof title === "string"
          ? registerTest(skipRegister)(title, second, third)
          : (e2eTest.skip as Any)(title, second),
      { each: (table: readonly unknown[]) => eachOver(skipRegister, table) },
    ),
    configurable: true,
  },
  only: {
    value: Object.assign(
      (title: string, second: Any, third?: Any) =>
        registerTest(onlyRegister)(title, second, third),
      { each: (table: readonly unknown[]) => eachOver(onlyRegister, table) },
    ),
    configurable: true,
  },
  todo: {
    value: (title: string) => e2eRegister(title, () => undefined),
    configurable: true,
  },
  fails: {
    value: (title: string, second: Any, third?: Any) =>
      registerTest(e2eRegister)(title, second, third),
    configurable: true,
  },
  skipIf: {
    value: (condition: boolean) => (condition ? test.skip : test),
    configurable: true,
  },
  runIf: {
    value: (condition: boolean) => (condition ? test : test.skip),
    configurable: true,
  },
  concurrent: { value: test, configurable: true },
  sequential: { value: test, configurable: true },
});

type DescribeAPI = typeof e2eDescribe;

export const describe = ((title: string, body: Any, maybeBody?: Any) => {
  const name = clampTitle(title, "describe");
  return withinGroup(name, () => (e2eDescribe as Any)(name, body, maybeBody));
}) as unknown as DescribeAPI & DescribeExtras;

Object.defineProperties(describe, {
  each: {
    value: (table: readonly unknown[]) => {
      const rows = casesOf(table);
      return (title: string, body: Any, maybeBody?: Any) => {
        const options = typeof body === "function" ? undefined : body;
        const inner = (typeof body === "function" ? body : maybeBody) as Body;
        for (const row of rows) {
          const name = expand(title, [...row.args], row.named);
          withinGroup(name, () =>
            options
              ? (e2eDescribe as Any)(name, options, () => inner(...row.args))
              : (e2eDescribe as Any)(name, () => inner(...row.args)),
          );
        }
      };
    },
    configurable: true,
  },
  skip: {
    value: (title: string, body: Any, maybeBody?: Any) => {
      // e2e would call a whole skipped group "no runnable test"; skipping inside each body keeps the
      // file executable and the verdict the same.
      setSkipping(skippingOf() + 1);
      try {
        const inner = typeof body === "function" ? body : maybeBody;
        const name = clampTitle(title, "describe");
        return withinGroup(name, () =>
          (e2eDescribe as Any)(name, () => inner?.()),
        );
      } finally {
        setSkipping(skippingOf() - 1);
      }
    },
    configurable: true,
  },
  only: {
    value: (title: string, body: Any, maybeBody?: Any) => {
      const name = clampTitle(title, "describe");
      return withinGroup(name, () =>
        (e2eDescribe as Any)(name, body, maybeBody),
      );
    },
    configurable: true,
  },
  concurrent: { value: describe, configurable: true },
  skipIf: {
    value: (condition: boolean) => (condition ? describe.skip : describe),
    configurable: true,
  },
  runIf: {
    value: (condition: boolean) => (condition ? describe : describe.skip),
    configurable: true,
  },
  serial: {
    value: (title: string, body: Any, maybeBody?: Any) => {
      const options =
        typeof body === "function"
          ? { serial: true }
          : { ...body, serial: true };
      const inner = typeof body === "function" ? body : maybeBody;
      const name = clampTitle(title, "describe");
      return withinGroup(name, () =>
        (e2eDescribe as Any)(name, options, inner),
      );
    },
    configurable: true,
  },
});

export const it = test;
export const beforeEach = e2eBeforeEach;
export const afterEach = e2eAfterEach;
export const beforeAll = e2eBeforeAll;
export const afterAll = e2eAfterAll;
