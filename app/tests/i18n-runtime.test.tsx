import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Trans, i18n, t, useTranslation } from "@/i18n";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * The translation runtime on the path every interface test takes: Bun, Happy DOM, Testing Library.
 * It is the evidence that i18next + react-i18next + i18next-icu work here, so the choice stands.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  i18n.addResourceBundle(
    "en",
    "translation",
    {
      "test.items": "{count, plural, one {# item} other {# items}} for {name}",
      "test.notice": "Read the <0>release notes</0> for {product}.",
      "test.englishOnly": "Only ever written in English.",
    },
    true,
    true,
  );
  i18n.addResourceBundle(
    "zh-CN",
    "translation",
    {
      "test.items": "{name} 有 {count} 项",
      "test.notice": "阅读 {product} 的<0>发行说明</0>。",
    },
    true,
    true,
  );
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(async () => {
  cleanup();
  await pinLocale("en");
});

function Items({ count }: { count: number }) {
  const { t } = useTranslation();
  return <p>{t("test.items", { count, name: "Ada" })}</p>;
}

function Notice({ product }: { product: string }) {
  return (
    <p>
      <Trans
        i18nKey="test.notice"
        values={{ product }}
        components={[<a href="/notes">release notes</a>]}
      />
    </p>
  );
}

test("a message interpolates and agrees in number in English", () => {
  const view = render(<Items count={1} />);
  expect(view.getByRole("paragraph").textContent).toBe("1 item for Ada");
  view.rerender(<Items count={2} />);
  expect(view.getByRole("paragraph").textContent).toBe("2 items for Ada");
});

test("choosing Simplified Chinese redraws the text in place, without a new page", async () => {
  const view = render(<Items count={3} />);
  const before = view.getByRole("paragraph");

  await pinLocale("zh-CN");

  const after = view.getByRole("paragraph");
  expect(after).toBe(before);
  expect(after.textContent).toBe("Ada 有 3 项");
});

test("a sentence with a link in it stays one message, in either language", async () => {
  const view = render(<Notice product="OpenBot" />);
  expect(
    view.getByRole("link", { name: "release notes" }).getAttribute("href"),
  ).toBe("/notes");

  await pinLocale("zh-CN");

  expect(
    view.getByRole("link", { name: "发行说明" }).getAttribute("href"),
  ).toBe("/notes");
  expect(view.getByRole("paragraph").textContent).toBe(
    "阅读 OpenBot 的发行说明。",
  );
});

test("a value that looks like markup is shown as it was written", async () => {
  const view = render(<Notice product="a<b & c" />);
  expect(view.getByRole("paragraph").textContent).toBe(
    "Read the release notes for a<b & c.",
  );
  expect(view.queryByText("b & c")).toBeNull();

  await pinLocale("zh-CN");

  expect(view.getByRole("paragraph").textContent).toBe(
    "阅读 a<b & c 的发行说明。",
  );
});

test("text asked for outside React is in the language current at the call", async () => {
  expect(t("test.items", { count: 1, name: "Ada" })).toBe("1 item for Ada");

  await pinLocale("zh-CN");

  expect(t("test.items", { count: 1, name: "Ada" })).toBe("Ada 有 1 项");
});

test("a message that was never translated is shown in English", async () => {
  const view = render(<EnglishOnly />);
  await pinLocale("zh-CN");

  expect(view.getByRole("paragraph").textContent).toBe(
    "Only ever written in English.",
  );
});

function EnglishOnly() {
  const { t } = useTranslation();
  return <p>{t("test.englishOnly")}</p>;
}
