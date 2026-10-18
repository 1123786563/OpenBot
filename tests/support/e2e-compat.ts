import { registerHooks } from "node:module";
import { inspect } from "node:util";
// Installed as a side effect: suites that probe the app the Bun way keep working on Node's runtime.
import "./bun-compat";
import {
  afterAll as e2eAfterAll,
  afterEach as e2eAfterEach,
  beforeAll as e2eBeforeAll,
  beforeEach as e2eBeforeEach,
  describe as e2eDescribe,
  expect as e2eExpect,
  test as e2eTest,
} from "e2e";

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
): void {
  if (!DELEGATED.has(matcher)) {
    throw new Error(
      `expect(...).${label}${matcher}() is not a matcher of this runner`,
    );
  }
  const base = e2eExpect(actual);
  (negate ? base.not : base)[matcher](...args);
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
): void {
  if (ADDED.has(name)) expectAdded(name, actual, args, negate, label);
  else callsE2e(actual, name, args, negate, label);
}

/** `.resolves` / `.rejects`: every matcher method returns a promise, so `await` settles it. */
function asyncChain(
  actual: Any,
  kind: "resolves" | "rejects",
  negate: boolean,
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
    applyMatcher(name, value, args, negate, `${kind}.`);
  };
  return new Proxy({} as Any, {
    get: (_target, key: string) => {
      if (key === "not") return asyncChain(actual, kind, !negate);
      if (typeof key === "string" && (key === "then" || key === "catch")) {
        return (...args: unknown[]) =>
          Promise.resolve().then(...(args as [Any]));
      }
      return (...args: unknown[]) => run(key, args);
    },
  });
}

function buildExpectation(actual: Any, negate: boolean, label: string): Any {
  return new Proxy({} as Any, {
    get: (_target, key: string) => {
      if (key === "not") return buildExpectation(actual, !negate, "not.");
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
        applyMatcher(key, actual, args, negate, label);
      };
    },
  });
}

export const expect: Any = (actual: Any, _message?: string) =>
  buildExpectation(actual, false, "");
for (const name of [
  "any",
  "anything",
  "arrayContaining",
  "objectContaining",
  "stringContaining",
  "stringMatching",
] as const) {
  expect[name] = (e2eExpect as Any)[name];
}
expect.soft = (actual: Any) => buildExpectation(actual, false, "soft.");
expect.assertions = () => undefined;
expect.hasAssertions = () => undefined;
expect.fail = (message?: string) => {
  throw new Error(message ?? "expect.fail()");
};

/* --------------------------------------------------------------------- spies */

export interface Mock {
  (...args: any[]): any;
  mock: {
    calls: any[][];
    results: { type: string; value: unknown }[];
    instances: unknown[];
    lastCall?: any[];
  };
  _isMockFunction: true;
  mockImplementation(next: (...args: any[]) => unknown): Mock;
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

export function mock(
  implementation: (...args: any[]) => unknown = () => undefined,
): Mock {
  return makeMock(implementation);
}

/* --------------------------------------------------------- module mocking */

const MOCK_REGISTRY = Symbol.for("openbot.e2e-compat.module-mocks");
const mocks: Map<string, unknown[]> = ((globalThis as Any)[MOCK_REGISTRY] ??=
  new Map());
const moduleMocks: Map<string, () => Record<string, unknown>> = new Map();
let hooksInstalled = false;

/*
 * `mock.module(specifier, factory)` over Node's loader hooks.
 *
 * The generated module reads the factory's exports back from a process-wide registry, so any
 * specifier can be mocked, including the `@/...` aliases and relative paths `spyOn` cannot reach.
 * Like Bun's it is registry level and outlives the file that set it, which is why suites import the
 * mocked module only after calling it.
 */
function installMockHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    resolve: (specifier: string, _context: Any, nextResolve: Any) => {
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
      if (!url.startsWith("e2e-mock:")) return nextLoad(url, context);
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

(mock as Any).module = (
  specifier: string,
  factory: () => Record<string, unknown>,
): (() => void) => {
  installMockHooks();
  moduleMocks.set(specifier, factory);
  mocks.set(specifier, Object.values(factory()));
  return () => {
    moduleMocks.delete(specifier);
    mocks.delete(specifier);
  };
};
(mock as Any).restore = () => {
  moduleMocks.clear();
  mocks.clear();
};

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
  Date: globalThis.Date,
};
let clock = false;
let now = 0;
let nextId = 1;
let timers: FakeTimer[] = [];

class FakeDate extends real.Date {
  constructor(...args: any[]) {
    super(...(args.length === 0 ? [now] : args));
  }
  static now(): number {
    return now;
  }
}

export function useFakeTimers(): void {
  if (clock) return;
  clock = true;
  now = real.Date.now();
  timers = [];
  const schedule = (every: 0 | 1) =>
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
      return timer.id as any;
    }) as Any;
  globalThis.setTimeout = schedule(0);
  globalThis.setInterval = schedule(1);
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
  globalThis.setTimeout = real.setTimeout;
  globalThis.setInterval = real.setInterval;
  globalThis.clearTimeout = real.setTimeout;
  globalThis.clearInterval = real.setInterval;
  globalThis.Date = real.Date;
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
  const withNames = out.replace(/\$(\w+)/g, (_m, key: string) =>
    named && typeof named === "object" ? String(named[key]) : `$${key}`,
  );
  const rest = args.slice(index);
  return rest.length
    ? `${withNames} ${rest.map((v) => formatToken("p", v)).join(" ")}`
    : withNames;
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

function registerTest(register: Register) {
  return (title: string, second: Any, third?: Any): unknown => {
    // Bun's `test(title, fn, timeoutMs)` puts the deadline in a third positional argument.
    if (typeof second === "function" && typeof third === "number") {
      return register(title, { timeout: third }, second);
    }
    if (typeof second === "function") {
      return third === undefined
        ? register(title, second)
        : register(title, translate(third), second);
    }
    const options = translate(second);
    // e2e reads the argument count: a three-argument call whose options are undefined is a collection error.
    return options === undefined
      ? register(title, third)
      : register(title, options, third);
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

const e2eRegister: Register = (...args) => {
  trace("test", args);
  try {
    return (e2eTest as Any)(...args);
  } catch (error) {
    if (process.env.E2E_COMPAT_DEBUG) console.error((error as Error).stack);
    throw error;
  }
};
const onlyRegister: Register = (...args) => (e2eTest.only as Any)(...args);
// `test.skip(title, options, fn)` is not a call shape e2e takes: skipping at collection is an option.
const skipRegister: Register = (title, second, third) =>
  typeof second === "function"
    ? (e2eTest as Any)(title, { skip: true }, second)
    : (e2eTest as Any)(title, { ...(second ?? {}), skip: true }, third);

type TestAPI = typeof e2eTest;

export const test = ((title: string, second: Any, third?: Any) =>
  registerTest(e2eRegister)(title, second, third)) as TestAPI &
  Record<string, unknown>;

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

export const describe = ((title: string, body: Any, maybeBody?: Any) =>
  (e2eDescribe as Any)(title, body, maybeBody)) as DescribeAPI &
  Record<string, unknown>;

Object.defineProperties(describe, {
  each: {
    value: (table: readonly unknown[]) => {
      const rows = casesOf(table);
      return (title: string, body: Any, maybeBody?: Any) => {
        const options = typeof body === "function" ? undefined : body;
        const inner = (typeof body === "function" ? body : maybeBody) as Body;
        for (const row of rows) {
          const name = expand(title, [...row.args], row.named);
          if (options)
            (e2eDescribe as Any)(name, options, () => inner(...row.args));
          else (e2eDescribe as Any)(name, () => inner(...row.args));
        }
      };
    },
    configurable: true,
  },
  skip: {
    value: (title: string, body: Any, maybeBody?: Any) => {
      const options =
        typeof body === "function" ? { skip: true } : { ...body, skip: true };
      const inner = typeof body === "function" ? body : maybeBody;
      return (e2eDescribe as Any)(title, options, inner);
    },
    configurable: true,
  },
  only: {
    value: (title: string, body: Any, maybeBody?: Any) =>
      (e2eDescribe as Any)(title, body, maybeBody),
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
      return (e2eDescribe as Any)(title, options, inner);
    },
    configurable: true,
  },
});

export const it = test;
export const beforeEach = e2eBeforeEach;
export const afterEach = e2eAfterEach;
export const beforeAll = e2eBeforeAll;
export const afterAll = e2eAfterAll;
