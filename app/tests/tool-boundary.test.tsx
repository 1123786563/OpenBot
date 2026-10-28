import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import i18next from "i18next";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { ToolRenderBoundary } from "../src/components/channels/tool-boundary";
import { settleReactWork } from "./settle-react-work";

/*
 * FIX-OCR2 (O2-M7): a render-time exception must not unmount the channel. `toVisibleChatItems`
 * itself is guarded row by row (chat-messages.test.ts holds that half), but the transcript also
 * renders model-authored components whose arguments nothing upstream validates — and a throw
 * from inside a component escapes into React and takes the whole channel view down with it: one
 * bad card anywhere and the conversation is a blank screen. `ToolRenderBoundary` is the fence:
 * the failure is contained to the card, shown as a person-readable line, and every sibling row
 * stays mounted. This file pins that containment with a component that throws in render.
 */

beforeAll(async () => {
  GlobalRegistrator.register();
  // The failure line is localized; this file asserts its English shape.
  await i18next.changeLanguage("en");
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Boom(): never {
  throw new Error("render exploded");
}

test("a component that throws in render is isolated: the failure line shows, the channel stays up", async () => {
  const view = render(
    <main>
      <p>The person's own last message</p>
      <ToolRenderBoundary name="tripCard">
        <Boom />
      </ToolRenderBoundary>
      <p>The next turn of the conversation</p>
    </main>,
  );
  // The failed card names itself and says what that cost — one card, not the channel.
  expect(await view.findByText("tripCard")).toBeTruthy();
  expect(view.getByText(/could not be drawn/)).toBeTruthy();
  // And the rows around it did not unmount: the conversation is still on screen.
  expect(view.getByText("The person's own last message")).toBeTruthy();
  expect(view.getByText("The next turn of the conversation")).toBeTruthy();
});
