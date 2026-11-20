import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { GovernanceSearch } from "@/components/astryx-pilot/governance";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("People search receives the typed query", async () => {
  function Search() {
    const [query, setQuery] = useState("");
    return (
      <GovernanceSearch
        label="Search people"
        onChange={(event) => setQuery(event.target.value)}
        value={query}
      />
    );
  }

  const view = render(<Search />);
  const input = view.getByRole("searchbox", { name: "Search people" });
  await userEvent.setup({ document: window.document }).type(input, "Sam");
  expect(input).toHaveProperty("value", "Sam");
});
