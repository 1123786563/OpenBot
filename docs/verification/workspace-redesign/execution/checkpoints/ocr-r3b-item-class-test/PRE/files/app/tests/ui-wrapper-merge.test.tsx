import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Field, FieldError } from "@/components/ui/field";
import { Item } from "@/components/ui/item";
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

test("Field preserves normalized invalid state when forwarding props", () => {
  const view = render(
    <Field data-invalid="true" aria-describedby="existing">
      <FieldError>Invalid value</FieldError>
    </Field>,
  );
  const group = view.getByRole("group");
  expect(group.getAttribute("data-invalid")).toBe("true");
  expect(group.getAttribute("aria-describedby")).toContain("existing");
  expect(group.getAttribute("aria-describedby")).toContain(
    view.getByRole("alert").id,
  );

  const validView = render(<Field data-invalid="false" />);
  expect(
    validView.container
      .querySelector("[data-slot=field]")
      ?.hasAttribute("data-invalid"),
  ).toBe(false);
});

test("Item element class and style win while both click handlers run in order", () => {
  const calls: string[] = [];
  const view = render(
    <Item
      className="wrapper-class"
      style={{ color: "red", marginTop: "2px" }}
      onClick={() => calls.push("item")}
      render={
        <button
          className="element-class"
          style={{ color: "blue" }}
          onClick={() => calls.push("element")}
          type="button"
        />
      }
    >
      Choose
    </Item>,
  );
  const button = view.getByRole("button", { name: "Choose" });
  expect(button.className).toContain("element-class");
  expect(button.style.color).toBe("blue");
  expect(button.style.marginTop).toBe("2px");
  button.click();
  expect(calls).toEqual(["element", "item"]);
});
