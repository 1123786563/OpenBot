import { describe, expect, test } from "bun:test";
import {
  SETTINGS_SIDEBAR_ITEMS,
  settingsSidebarItems,
} from "../src/components/settings/settings-sidebar";

describe("settings sidebar", () => {
  test("Browsers links to /settings/browsers, right after Approvals", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const browsers = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("Browsers")];

    expect(browsers?.linkOptions).toEqual({ to: "/settings/browsers" });
    expect(titles.indexOf("Browsers")).toBe(titles.indexOf("Approvals") + 1);
  });

  test("Learning links to /settings/learning, right after Browsers", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const learning = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("Learning")];

    expect(learning?.linkOptions).toEqual({ to: "/settings/learning" });
    expect(titles.indexOf("Learning")).toBe(titles.indexOf("Browsers") + 1);
  });
});

test("Team Settings links to Computer only for enrolled users", () => {
  expect(
    settingsSidebarItems("team").some((item) => item.title === "Computer"),
  ).toBe(false);
  expect(
    settingsSidebarItems("team", true).find((item) => item.title === "Computer")
      ?.linkOptions,
  ).toEqual({
    to: "/settings/computer",
  });
});
