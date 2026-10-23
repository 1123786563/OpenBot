import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Field, FieldError } from "@/components/ui/field";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/*
 * The id a Field invents for its error only describes something when a FieldError actually
 * rendered it. A reference to an absent element is dropped silently by assistive technology,
 * which is worse than offering no reference at all.
 */
test("an invalid Field only describes an error that is actually rendered", () => {
  const bare = render(
    <Field data-invalid="true" aria-describedby="existing" />,
  );
  expect(bare.getByRole("group").getAttribute("aria-describedby")).toBe(
    "existing",
  );
  // Out of the document before the next render: render-bound queries resolve from the shared
  // body, and two mounted groups would make every role query here ambiguous.
  bare.unmount();

  const withError = render(
    <Field data-invalid="true" aria-describedby="existing">
      <FieldError>Required</FieldError>
    </Field>,
  );
  expect(withError.getByRole("group").getAttribute("aria-describedby")).toBe(
    `existing ${withError.getByRole("alert").id}`,
  );
});

test("a FieldError with nothing to say renders nothing and is not described", () => {
  const view = render(
    <Field data-invalid="true">
      <FieldError errors={[]} />
    </Field>,
  );
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByRole("group").getAttribute("aria-describedby")).toBeNull();
});
