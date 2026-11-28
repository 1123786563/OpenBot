import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type DecisionAnswer,
  DecisionCard,
  OTHER,
} from "@/components/decisions/decision-card";
import { settleReactWork } from "./settle-react-work";

/**
 * The card a Bot's question and every approval are drawn in: rows with what each does, the first
 * picked, one button named for the pick, 1 to 9 and Enter on the newest waiting card, and a fold
 * into the answer once given.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const OPTIONS = [
  { value: "staging", label: "Staging", description: "Safe, and reversible" },
  { value: "production", label: "Production", description: "Live customers" },
];

function card(
  sent: [string, string][],
  props: { title?: string; answer?: DecisionAnswer; other?: boolean } = {},
) {
  return (
    <DecisionCard
      {...(props.answer ? { answer: props.answer } : {})}
      onSubmit={(value, text) => {
        sent.push([value, text]);
      }}
      options={OPTIONS}
      {...(props.other
        ? { other: { placeholder: "Answer something else…" } }
        : {})}
      title={props.title ?? "Which environment?"}
    />
  );
}

test("each answer is a row with what it does, the first is picked, and the button says it", () => {
  const view = render(card([]));
  const staging = view.getByRole("radio", { name: "Staging" });
  expect((staging as HTMLInputElement).checked).toBe(true);
  expect(staging.getAttribute("aria-describedby")).toBeTruthy();
  expect(view.getByText("Live customers")).toBeTruthy();
  expect(view.getByRole("button", { name: "Staging" })).toBeTruthy();
  expect(view.getByText("Waiting on you")).toBeTruthy();
});

test("a number picks its row and Enter sends it", async () => {
  const sent: [string, string][] = [];
  const view = render(card(sent));
  const user = userEvent.setup({ document });
  await user.keyboard("2");
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Production" })).toBeTruthy(),
  );
  await user.keyboard("{Enter}");
  expect(sent).toEqual([["production", ""]]);
});

test("only the newest waiting card takes the keys", async () => {
  const first: [string, string][] = [];
  const second: [string, string][] = [];
  const view = render(
    <>
      {card(first, { title: "First" })}
      {card(second, { title: "Second" })}
    </>,
  );
  const user = userEvent.setup({ document });
  await user.keyboard("2");
  await user.keyboard("{Enter}");
  expect(first).toEqual([]);
  expect(second).toEqual([["production", ""]]);
  expect(
    (
      within(view.getByRole("radiogroup", { name: "First" })).getByRole(
        "radio",
        {
          name: "Staging",
        },
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test("typing elsewhere never picks or sends", async () => {
  const sent: [string, string][] = [];
  const view = render(
    <>
      <textarea aria-label="Message" />
      {card(sent)}
    </>,
  );
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("textbox", { name: "Message" }));
  await user.keyboard("2{Enter}");
  expect(sent).toEqual([]);
  expect(view.getByRole("button", { name: "Staging" })).toBeTruthy();
});

test("the last row takes words instead, and Enter in it sends them", async () => {
  const sent: [string, string][] = [];
  const view = render(card(sent, { other: true }));
  const user = userEvent.setup({ document });
  await user.type(
    view.getByRole("textbox", { name: "Your answer" }),
    "Neither, wait for Monday{Enter}",
  );
  expect(sent).toEqual([[OTHER, "Neither, wait for Monday"]]);
});

test("the words row needs words before it can be sent", async () => {
  const sent: [string, string][] = [];
  const view = render(card(sent, { other: true }));
  const user = userEvent.setup({ document });
  await user.keyboard("3");
  const button = await view.findByRole("button", { name: "Send" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
});

test("answered, it folds into one line with the answer, and takes no keys", async () => {
  const sent: [string, string][] = [];
  const view = render(
    card(sent, {
      answer: { label: "Answered", choice: "Production", tone: "positive" },
    }),
  );
  expect(view.queryByRole("radio")).toBeNull();
  expect(view.getByText("Answered")).toBeTruthy();
  expect(view.getByText("Production")).toBeTruthy();
  const user = userEvent.setup({ document });
  await user.keyboard("1{Enter}");
  expect(sent).toEqual([]);
});

/** A card whose caller says what is on its way, as the approval card does. */
function HeldCard({
  sent,
  submitting = false,
  error = null,
  answer,
}: {
  sent: [string, string][];
  submitting?: boolean;
  error?: string | null;
  answer?: DecisionAnswer;
}) {
  return (
    <DecisionCard
      {...(answer ? { answer } : {})}
      error={error}
      onSubmit={(value, text) => {
        sent.push([value, text]);
      }}
      options={OPTIONS}
      submitting={submitting}
      title="Which environment?"
    />
  );
}

/*
 * A SEND THAT WENT THROUGH IS FINAL. The card unlocked again as soon as the caller said nothing was
 * on its way, which is also what it says once the decision is in: until the caller's next read
 * folded the card away, a second press sent a second decision, and the server refused it.
 */
test("a decision that was sent is not sent again while the card is still on screen", async () => {
  const sent: [string, string][] = [];
  const view = render(<HeldCard sent={sent} />);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Staging" }));
  // On its way, then through, and still drawn until the caller takes it away.
  view.rerender(<HeldCard sent={sent} submitting />);
  view.rerender(<HeldCard sent={sent} />);
  await user.click(view.getByRole("button", { name: "Staging" }));
  expect(sent).toEqual([["staging", ""]]);
});

test("a card that has its answer takes no second decision", async () => {
  const sent: [string, string][] = [];
  const answer: DecisionAnswer = {
    label: "Answered",
    choice: "Staging",
    tone: "positive",
  };
  const view = render(<HeldCard sent={sent} />);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Staging" }));
  view.rerender(<HeldCard answer={answer} sent={sent} />);
  // The rows are still folding away, so the button is still on screen.
  await user.click(view.getByRole("button", { name: "Staging" }));
  expect(sent).toEqual([["staging", ""]]);
});

/*
 * A REFUSED ONE CAN BE PRESSED AGAIN. A send that settles inside one render never says it was on
 * its way, and the card stayed locked for good: the button looked ready and did nothing.
 */
test("a decision that came back refused can be sent again, though nothing showed it was on its way", async () => {
  const sent: [string, string][] = [];
  const view = render(<HeldCard sent={sent} />);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Staging" }));
  view.rerender(
    <HeldCard error="This request was already decided." sent={sent} />,
  );
  await user.click(view.getByRole("button", { name: "Staging" }));
  expect(sent).toEqual([
    ["staging", ""],
    ["staging", ""],
  ]);
});

test("a decision that came back refused on its way can be sent again too", async () => {
  const sent: [string, string][] = [];
  const view = render(<HeldCard sent={sent} />);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Staging" }));
  view.rerender(<HeldCard sent={sent} submitting />);
  view.rerender(<HeldCard error="Couldn't reach the server." sent={sent} />);
  await user.click(view.getByRole("button", { name: "Staging" }));
  expect(sent).toEqual([
    ["staging", ""],
    ["staging", ""],
  ]);
});
