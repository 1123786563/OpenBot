import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { useLocale, useTranslator } from "@astryxdesign/core/i18n";
import {
  I18nProvider,
  Trans,
  formatDate,
  formatNumber,
  formatRelativeTime,
  i18n,
  initI18n,
  readLocalePreference,
  t,
  useLocalePreference,
  useTranslation,
} from "@/i18n";
import { pinLocale, withStorage } from "./i18n";
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
      "test.untranslated": "Not written in Chinese yet.",
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
      // What extraction leaves behind for a key no one has translated yet.
      "test.untranslated": "",
    },
    true,
    true,
  );
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
beforeEach(() => localStorage.clear());
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
        components={[
          <a href="/notes" key="notes">
            release notes
          </a>,
        ]}
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

function Untranslated() {
  const { t } = useTranslation();
  return <p>{t("test.untranslated", "Not written in Chinese yet.")}</p>;
}

test("a message nobody has translated yet is shown in English, never blank or as its ID", async () => {
  const view = render(<Untranslated />);
  await pinLocale("zh-CN");

  expect(view.getByRole("paragraph").textContent).toBe(
    "Not written in Chinese yet.",
  );
});

/** Makes the browser ask for `languages`, most preferred first, until the returned function runs. */
function browserSpeaks(languages: string[]): () => void {
  const asked = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", {
    configurable: true,
    get: () => languages,
  });
  return () => {
    if (asked) Object.defineProperty(navigator, "languages", asked);
    else Reflect.deleteProperty(navigator, "languages");
  };
}

test("the interface speaks the browser's language from its very first frame", () => {
  const unSpeak = browserSpeaks(["zh-Hans-CN"]);
  try {
    initI18n();

    expect(document.documentElement.lang).toBe("zh-CN");
    expect(render(<Items count={3} />).getByRole("paragraph").textContent).toBe(
      "Ada 有 3 项",
    );
  } finally {
    unSpeak();
  }
});

test("a language this browser was told to keep beats what the browser asks for", () => {
  localStorage.setItem("openbot-locale", "en");
  const unSpeak = browserSpeaks(["zh-Hans-CN"]);
  try {
    initI18n();
  } finally {
    unSpeak();
  }

  expect(document.documentElement.lang).toBe("en");
});

test("choosing a language tells the document, and this browser keeps the choice", async () => {
  const unSpeak = browserSpeaks(["en-GB"]);
  try {
    await pinLocale("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(readLocalePreference()).toBe("zh-CN");

    await pinLocale("browser");
    expect(document.documentElement.lang).toBe("en");
    expect(readLocalePreference()).toBe("browser");
  } finally {
    unSpeak();
  }
});

test("a language can still be chosen where the browser refuses to keep it", async () => {
  const refused = (): never => {
    throw new DOMException(
      "Access is denied for this document.",
      "SecurityError",
    );
  };
  await withStorage({ getItem: refused, setItem: refused }, async () => {
    await pinLocale("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(t("test.englishOnly")).toBe("Only ever written in English.");
  });
});

function PreferenceProbe() {
  return <p>{useLocalePreference() ?? "none"}</p>;
}

test("what was chosen is visible to the interface while it runs", async () => {
  const view = render(<PreferenceProbe />);
  await pinLocale("browser");
  expect(view.getByRole("paragraph").textContent).toBe("browser");
  await pinLocale("zh-CN");
  expect(view.getByRole("paragraph").textContent).toBe("zh-CN");
});

function AstryxProbe() {
  const locale = useLocale();
  const translate = useTranslator();
  return <p>{`${locale} ${translate("@astryx.dialog.close")}`}</p>;
}

test("Astryx components speak the same language as OpenBot's own strings", async () => {
  await pinLocale("zh-CN");
  const view = render(
    <I18nProvider>
      <AstryxProbe />
    </I18nProvider>,
  );
  expect(view.getByRole("paragraph").textContent).toBe("zh-CN 关闭");

  await pinLocale("en");
  expect(view.getByRole("paragraph").textContent).toBe("en Close");
});

test("dates, numbers and relative times come out in the language in force", async () => {
  const march = new Date(2026, 2, 5);
  expect(formatDate(march, { dateStyle: "long" })).toBe("March 5, 2026");
  expect(formatNumber(12345, { notation: "compact" })).toBe("12K");
  expect(formatRelativeTime(-3, "day")).toBe("3 days ago");

  await pinLocale("zh-CN");
  expect(formatDate(march, { dateStyle: "long" })).toBe("2026年3月5日");
  expect(formatNumber(12345, { notation: "compact" })).toBe("1.2万");
  expect(formatRelativeTime(-3, "day")).toBe("3天前");

  await pinLocale("en");
});
