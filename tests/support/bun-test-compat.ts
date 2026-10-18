import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";

/*
 * The suite API for groups that e2e schedules but Bun executes.
 *
 * `tests/bun-suites.test.ts` runs those files under `bun test`, because they reach Bun's SQL client,
 * Bun's HTTP `serve`, or loader behaviour Node does not have. Under that runner `bun:test` is the
 * registry, so these files import it from here instead of the e2e compat layer. The split is
 * recorded in docs/verification/e2e-bun-suites.json and applied by scripts/e2e-apply-partition.mjs.
 */

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
  test,
};

export type Mock<T extends (...args: any[]) => any = (...args: any[]) => any> =
  ReturnType<typeof mock<T>>;
