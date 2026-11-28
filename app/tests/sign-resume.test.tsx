import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider, initI18n } from "@/i18n";
import { authKeys } from "@/lib/auth/queries";
import { appReturnPath, resumeUrlFor } from "@/lib/auth/resume";
import { pinLocale } from "./i18n";

/*
 * The Better Auth client is replaced at the module boundary: its fetch is captured when it is built,
 * so a test cannot intercept the request. What this pins is what the screen hands the starter.
 */
type SignInSpy = (
  provider: string,
  start: unknown,
  callbackURL?: string,
) => Promise<void>;
type DomainSignInSpy = (
  email: string,
  start: unknown,
  callbackURL?: string,
) => Promise<void>;
const realAuthClient = { ...(await import("@/lib/auth/client")) };
let signInSpy: SignInSpy = async () => {};
let domainSignInSpy: DomainSignInSpy = async () => {};
/*
 * BOTH LEGS ARE SPIED, AND NEITHER IS A NO-OP. Replacing the module is how the screen is tested at
 * all, but a replacement nobody asserts against tests nothing: `signInWithEmailDomain` stood here
 * as `async () => {}` while the SSO form's callbackURL went unpinned, so the screen could stop
 * passing the resume URL and this file stayed green. What the module boundary cannot see — the
 * real client dropping a callbackURL it was handed — is pinned in `auth-client.test.ts`, which
 * drives the real functions through their injectable starter. The two together cover the handoff.
 */
mock.module("@/lib/auth/client", () => ({
  /*
   * Display names come from the real table: a button that says Google for every id would make
   * "Microsoft/Okta keep their names" a test of the mock, not of the screen.
   */
  providerName: realAuthClient.providerName,
  signInWith: (...args: Parameters<SignInSpy>) => signInSpy(...args),
  signInWithEmailDomain: (...args: Parameters<DomainSignInSpy>) =>
    domainSignInSpy(...args),
}));
const { Route } = await import("@/routes/sign");

beforeAll(() => {
  GlobalRegistrator.register();
  // happy-dom starts at about:blank, whose origin is "null": nothing to build a callback URL on.
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL("http://localhost:3010/");
});
afterEach(async () => {
  cleanup();
  await pinLocale("en");
});
afterAll(() => {
  // Module mocks are process-wide in bun: hand the real client back to whatever runs next.
  mock.module("@/lib/auth/client", () => realAuthClient);
  GlobalRegistrator.unregister();
});

/*
 * THE HANDLE IS A VALUE, NEVER A DESTINATION: it is encoded into a path this code builds on this
 * origin, so what arrives in a URL cannot decide where the browser goes.
 */
test("resumeUrlFor puts an encoded handle on the verifier, and is the origin without one", () => {
  expect(resumeUrlFor("https://app.example", "a b&c/../d")).toBe(
    "https://app.example/api/plugins/arcade/verify?flow_id=a%20b%26c%2F..%2Fd",
  );
  expect(resumeUrlFor("https://app.example", undefined)).toBe(
    "https://app.example",
  );
  expect(resumeUrlFor("https://app.example", "")).toBe("https://app.example");
  // A hostile handle stays a value on this origin.
  const hostile = resumeUrlFor("https://app.example", "https://evil.test/");
  expect(new URL(hostile).origin).toBe("https://app.example");
  // Length-capped.
  expect(
    resumeUrlFor("https://app.example", "x".repeat(5000)).length,
  ).toBeLessThan(600);
});

test("validateSearch keeps the handle whatever shape the router parsed it into", () => {
  const validate = Route.options.validateSearch as (s: unknown) => object;
  expect(validate({ flow_id: "abc" })).toEqual({ flow_id: "abc" });
  /*
   * THE ROUTER JSON-PARSES SEARCH VALUES, so a handle the vendor happened to mint out of digits
   * arrives as a number and a JSON-shaped one as an object. Both are still the text the verifier
   * sent; dropping them is losing the correlation for whichever ids the generator happens to emit.
   */
  expect(validate({ flow_id: 12345 })).toEqual({ flow_id: "12345" });
  expect(validate({ flow_id: { a: 1 } })).toEqual({ flow_id: '{"a":1}' });
  expect(validate({ flow_id: ["a"] })).toEqual({ flow_id: '["a"]' });
  expect(validate({ flow_id: true })).toEqual({ flow_id: "true" });
  expect("flow_id" in validate({})).toBe(false);
});

/** The whole return leg: what the verifier put in the URL is what sign-in carries back to it. */
test("a numeric or JSON-shaped handle survives the round trip to the verifier", async () => {
  const validate = Route.options.validateSearch as (s: unknown) => {
    flow_id?: string;
  };
  const numeric = await redirectFrom(validate({ flow_id: 12345 }));
  expect(numeric.options.href).toBe("/api/plugins/arcade/verify?flow_id=12345");
  const shaped = await redirectFrom(validate({ flow_id: { a: 1 } }));
  expect(shaped.options.href).toBe(
    `/api/plugins/arcade/verify?flow_id=${encodeURIComponent('{"a":1}')}`,
  );
});

function signedInContext() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), { id: "u1" });
  return { queryClient };
}

async function redirectFrom(search: {
  flow_id?: string;
  openfuse_request?: string;
}) {
  const beforeLoad = Route.options.beforeLoad as (a: unknown) => Promise<void>;
  try {
    await beforeLoad({ context: signedInContext(), search });
  } catch (thrown) {
    return thrown as { options: { to?: string; href?: string } };
  }
  throw new Error("expected a redirect");
}

test("OpenFuse resumes only a registered sign-in request on the same origin", async () => {
  const handle = "a".repeat(64);
  const path = `/api/auth/openfuse/continue?request=${handle}`;
  expect(resumeUrlFor("https://app.example", undefined, handle)).toBe(
    `https://app.example${path}`,
  );
  expect((await redirectFrom({ openfuse_request: handle })).options.href).toBe(
    path,
  );
  expect(
    resumeUrlFor("https://app.example", undefined, "https://other.example/"),
  ).toBe("https://app.example");
});

test("a signed-in arrival with a handle goes to the verifier, without one to /", async () => {
  const withHandle = await redirectFrom({ flow_id: "f 1" });
  expect(withHandle.options.href).toBe(
    "/api/plugins/arcade/verify?flow_id=f%201",
  );
  const without = await redirectFrom({});
  expect(without.options.to).toBe("/");
  expect(without.options.href).toBeUndefined();
});

/** The sign screen on `/sign?flow_id=h1`, with whichever ways in the deployment offers. */
function renderSignScreen(
  options: {
    providers: string[];
    sso: boolean;
    ssoRequired: boolean;
    /**
     * The options read fails, the way it does behind `beforeLoad`'s swallow. The test makes `fetch`
     * refuse, so the failure is a real one and nothing is sent to the fake origin.
     */
    failed?: boolean;
  },
  initialEntry = "/sign?flow_id=h1",
) {
  // Retries off, so the one failed read refuses at once rather than after 7s of backing off.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Nothing seeded for a failed read: the screen shows its read-error, not a deployment with no way in.
  if (!options.failed) queryClient.setQueryData(authKeys.providers(), options);

  queryClient.setQueryData(authKeys.currentUser(), null);
  const root = createRootRoute();
  const sign = Route.update({
    id: "/sign",
    path: "/sign",
    getParentRoute: () => root,
  } as never);
  // The route tree is assembled by hand, so its types cannot describe it.
  const router = createRouter({
    routeTree: root.addChildren([sign]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  } as never) as never;
  // The real tree order from main.tsx: Astryx's language bridge sits above the app, so its own
  // words (a required marker) follow the interface language along with OpenBot's.
  const view = render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

test("the sign page translates its heading, title and provider action in place", async () => {
  const { view } = renderSignScreen({
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  expect(
    await view.findByRole("heading", { name: "Sign in to OpenBot" }),
  ).toBeTruthy();
  await pinLocale("zh-CN");
  expect(view.getByRole("heading", { name: "登录 OpenBot" })).toBeTruthy();
  expect(view.getByRole("button", { name: "使用 Google 继续" })).toBeTruthy();
  // The tab reads like every other page's, which PageShell titles: "<page> · OpenBot".
  expect(document.title).toBe("登录 · OpenBot");
  await pinLocale("en");
  expect(
    view.getByRole("button", { name: "Continue with Google" }),
  ).toBeTruthy();
  expect(document.title).toBe("Sign in · OpenBot");
});

test("the company form speaks the interface language, required marker included", async () => {
  const { view, user } = renderSignScreen({
    providers: ["google"],
    sso: true,
    ssoRequired: false,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });

  await pinLocale("zh-CN");
  expect(view.getByRole("textbox", { name: /公司邮箱/ })).toBeTruthy();
  // Astryx draws its own required marker through the same bridge, not in a second language.
  expect(view.getByText("必填")).toBeTruthy();
  expect(view.getByText("请使用你的组织发放的邮箱地址。")).toBeTruthy();
  expect(view.getByText("或")).toBeTruthy();
  const submit = view.getByRole("button", {
    name: "使用公司账号继续",
  }) as HTMLElement;
  // This screen disables with the native attribute, not Astryx's isDisabled.
  expect(submit.getAttribute("disabled")).toBe(""); // nothing typed yet
  await user.type(view.getByPlaceholderText("you@company.com"), "ada@corp.cn");
  expect(submit.getAttribute("disabled")).toBeNull();
  await user.click(submit);
  expect(view.getByRole("button", { name: "正在打开…" })).toBeTruthy();

  await pinLocale("en");
  expect(view.getByRole("textbox", { name: /Company email/ })).toBeTruthy();
  // The press above succeeded, so the button is still in its opening state — now in English.
  expect(view.getByRole("button", { name: "Opening…" })).toBeTruthy();
});

test("a deployment that requires the company account says so, in the interface language", async () => {
  const { view } = renderSignScreen({
    providers: ["google"],
    sso: true,
    ssoRequired: true,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });
  expect(
    view.getByText(
      "Your organization requires you to sign in with your company account.",
    ),
  ).toBeTruthy();

  await pinLocale("zh-CN");
  expect(view.getByText("你的组织要求你使用公司账号登录。")).toBeTruthy();
  // The administrators' break-glass keeps its summary in the interface language.
  // (happy-dom gives <summary> no role, so it is read as an element, not by role.)
  expect(view.container.querySelector("details > summary")?.textContent).toBe(
    "管理员登录",
  );
  expect(
    view.getByText(
      "如果你是此工作区的管理员，并且需要恢复公司登录，请使用此项。",
    ),
  ).toBeTruthy();

  await pinLocale("en");
  expect(view.container.querySelector("details > summary")?.textContent).toBe(
    "Admin sign-in",
  );
  expect(
    view.getByText(
      "Use this if you administer this workspace and need to restore company sign-in.",
    ),
  ).toBeTruthy();
});

test("opening a provider names it, in the interface language", async () => {
  const { view, user } = renderSignScreen({
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });

  await pinLocale("zh-CN");
  // Uninitialized on purpose: `= null` would keep it narrowed to null here, where the release the
  // executor stores is still typed as nothing.
  let release: (() => void) | undefined;
  try {
    signInSpy = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    await user.click(view.getByRole("button", { name: "使用 Google 继续" }));
    expect(view.getByRole("button", { name: "正在打开 Google…" })).toBeTruthy();

    await pinLocale("en");
    expect(view.getByRole("button", { name: "Opening Google…" })).toBeTruthy();
  } finally {
    release?.();
  }
});

test("a deployment with no way in says so, in the interface language", async () => {
  const { view } = renderSignScreen({
    providers: [],
    sso: false,
    ssoRequired: false,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });
  expect(
    view.getByText(
      "Ask your IT help desk or the person who invited you to check sign-in for this workspace. Check again when it’s ready.",
    ),
  ).toBeTruthy();
  expect(view.getByText("Sign-in isn’t set up yet.")).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Check sign-in options" }),
  ).toBeTruthy();

  await pinLocale("zh-CN");
  expect(
    view.getByText(
      "请让你的 IT 服务台或邀请你加入此工作区的人检查此工作区的登录设置。准备好后再检查一次。",
    ),
  ).toBeTruthy();
  expect(view.getByText("登录尚未配置。")).toBeTruthy();
  expect(view.getByRole("button", { name: "检查登录选项" })).toBeTruthy();
});

test("a required but unavailable company sign-in says so, in the interface language", async () => {
  const { view } = renderSignScreen({
    providers: [],
    sso: false,
    ssoRequired: true,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });
  expect(
    view.getByText("Company sign-in is required but unavailable."),
  ).toBeTruthy();

  await pinLocale("zh-CN");
  expect(view.getByText("需要公司登录，但当前不可用。")).toBeTruthy();
});

/** Where a press on this screen has to send the browser back to, with `?flow_id=h1` carried in. */
const RESUME_URL = "/api/plugins/arcade/verify?flow_id=h1";

test("the sign-in starter gets the resume URL as its callbackURL", async () => {
  const asked: string[] = [];
  signInSpy = async (_provider, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };

  const { view, user } = renderSignScreen({
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  await user.click(await view.findByText(/Continue with Google/));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(`${window.location.origin}${RESUME_URL}`);
});

/**
 * The company-account way in resumes too, and it was the leg nothing watched.
 *
 * A deployment whose people arrive through their own IdP has no provider buttons to press, so the
 * form below them IS the sign-in for everybody there. Leaving its callbackURL unpinned meant the
 * resume could be dropped for exactly those deployments and every test stayed green.
 */
test("the company-account form gets the resume URL as its callbackURL", async () => {
  const asked: string[] = [];
  domainSignInSpy = async (_email, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };

  const { view, user } = renderSignScreen({
    providers: [],
    sso: true,
    ssoRequired: false,
  });
  await user.type(
    await view.findByPlaceholderText("you@company.com"),
    "someone@company.com",
  );
  await user.click(
    await view.findByRole("button", {
      name: "Continue with your company account",
    }),
  );
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(`${window.location.origin}${RESUME_URL}`);
});

/*
 * THE RETURN LEG HAS TO ACTUALLY ARRIVE.
 *
 * The verifier is an API path, not a route in this app's tree. A redirect the router is left to
 * handle inside the app therefore matches nothing, and `__root.tsx`'s `notFoundComponent` sends an
 * unknown address home — so somebody who was asked to sign in half-way through connecting an app
 * signs in and lands on the home screen, with the authorization they started left behind and
 * nothing said about it. Only a document navigation reaches the verifier at all, which is why this
 * asserts on WHERE THE BROWSER ENDS UP rather than on the shape of the thrown redirect.
 */
test("a signed-in arrival with a handle lands on the verifier, not back on the home screen", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), { id: "u1" });
  queryClient.setQueryData(authKeys.providers(), {
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });

  // Leaving the single-page app is an assignment to `window.location`; record it rather than ask
  // happy-dom to fetch a path no server is listening on in this test.
  const left: string[] = [];
  const realLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      origin: realLocation.origin,
      get href() {
        return left.at(-1) ?? `${realLocation.origin}/sign?flow_id=h1`;
      },
      set href(url: string) {
        left.push(url);
      },
      replace: (url: string) => left.push(url),
      assign: (url: string) => left.push(url),
    },
  });

  const root = createRootRoute({
    component: () => <Outlet />,
    // Mirrors app/src/routes/__root.tsx: an address this build does not know goes home.
    notFoundComponent: () => <Navigate replace to="/" />,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <p>home</p>,
  });
  const sign = Route.update({
    id: "/sign",
    path: "/sign",
    getParentRoute: () => root,
  } as never);
  // The route tree is assembled by hand, so its types cannot describe it.
  const router = createRouter({
    routeTree: root.addChildren([home, sign]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/sign?flow_id=h1"] }),
  } as never) as never;

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    // Where the browser is: the document it was sent to, or the in-app location when it was never
    // sent anywhere.
    const destination = () =>
      left.at(-1) ??
      (router as unknown as { state: { location: { href: string } } }).state
        .location.href;
    await waitFor(() => expect(destination()).not.toContain("/sign"));
    expect(destination()).toBe("/api/plugins/arcade/verify?flow_id=h1");
    // And it got there by leaving the app, which is the only way the verifier is ever requested.
    expect(left).toEqual(["/api/plugins/arcade/verify?flow_id=h1"]);
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  }
});

test("sign-in retries by keyboard and returns to the requested page with its search and hash", async () => {
  const asked: (string | undefined)[] = [];
  signInSpy = async (_provider, _start, callbackURL) => {
    asked.push(callbackURL);
    if (asked.length === 1) throw new Error("Sign-in provider unavailable");
  };
  const target = "/settings/notifications?source=invite#updates";
  const { view, user } = renderSignScreen(
    { providers: ["google"], sso: false, ssoRequired: false },
    `/sign?returnTo=${encodeURIComponent(target)}`,
  );
  const button = await view.findByRole("button", {
    name: "Continue with Google",
  });
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  expect((await view.findByRole("alert")).textContent).toBe(
    "Sign-in provider unavailable",
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(asked).toHaveLength(2));
  expect(asked).toEqual(Array(2).fill(`${window.location.origin}${target}`));
});

test("only same-origin Web pages can be resumed, and an existing flow takes priority", () => {
  const origin = "https://app.example";
  const webReturn = "/desktop-return?app=calendar#done";
  expect(appReturnPath(webReturn)).toBe(webReturn);
  for (const value of [
    "https://elsewhere.example/",
    "//elsewhere.example/",
    "/sign",
    "/onboarding",
    "/api/me",
    42,
  ]) {
    expect(appReturnPath(value)).toBeUndefined();
  }
  expect(resumeUrlFor(origin, "flow", undefined, webReturn)).toBe(
    `${origin}/api/plugins/arcade/verify?flow_id=flow`,
  );
});

test("returns to a Web deep link without the newer URL.parse API", () => {
  const descriptor = Object.getOwnPropertyDescriptor(URL, "parse");
  Object.defineProperty(URL, "parse", { value: undefined, configurable: true });
  try {
    expect(appReturnPath("/bots?new=true#details")).toBe(
      "/bots?new=true#details",
    );
    expect(appReturnPath("//outside.example/bots")).toBeUndefined();
  } finally {
    if (descriptor) Object.defineProperty(URL, "parse", descriptor);
    else Reflect.deleteProperty(URL, "parse");
  }
});

test("a refused provider press passes the server's words through, and says its own in the interface language", async () => {
  const { view, user } = renderSignScreen({
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });

  await pinLocale("zh-CN");
  // The server's own sentence is a value: shown as it arrived, in either language.
  signInSpy = async () => {
    throw new Error("Sign-in provider unavailable");
  };
  await user.click(view.getByRole("button", { name: "使用 Google 继续" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Sign-in provider unavailable",
  );

  // Without a reason from the server, the screen says its own sentence.
  signInSpy = async () => {
    throw "no reason given";
  };
  await user.click(view.getByRole("button", { name: "使用 Google 继续" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "无法打开 Google 登录。请重试。",
  );

  await pinLocale("en");
  await user.click(view.getByRole("button", { name: "Continue with Google" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't open Google sign-in. Try again.",
  );
});

test("a refused company sign-in keeps the server's words and guides in the interface language", async () => {
  const { view, user } = renderSignScreen({
    providers: [],
    sso: true,
    ssoRequired: false,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });

  await pinLocale("zh-CN");
  await user.type(view.getByPlaceholderText("you@company.com"), "ada@corp.cn");
  // The server's sentence is a value inside a translated one, so it carries the characters an
  // escaping formatter, or a second pass of the parser, would change.
  const said = "Tom & Jerry's domain isn't registered (100%)";
  domainSignInSpy = async () => {
    throw new Error(said);
  };
  await user.click(view.getByRole("button", { name: "使用公司账号继续" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    `${said} 请检查你的公司邮箱后重试。如果问题仍然存在，请联系你的 OpenBot 管理员。`,
  );

  domainSignInSpy = async () => {
    throw "no reason given";
  };
  await user.click(view.getByRole("button", { name: "使用公司账号继续" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "无法打开公司登录。 请检查你的公司邮箱后重试。如果问题仍然存在，请联系你的 OpenBot 管理员。",
  );
});

test("a failed read of the sign-in options speaks the interface language, retry included", async () => {
  // `fetch` refuses, the way a dropped connection makes it. Nothing is sent to the fake origin —
  // whose port may be somebody's live server — and the screen renders from the failure `beforeLoad`
  // swallowed, not from seeded options.
  const realFetch = window.fetch;
  const offline = () => Promise.reject(new TypeError("offline"));
  window.fetch = Object.assign(offline, { preconnect: realFetch.preconnect });
  try {
    const { view, user } = renderSignScreen({
      providers: [],
      sso: false,
      ssoRequired: false,
      failed: true,
    });
    await view.findByText("Couldn't load sign-in options.");
    expect(view.getByText("Check your connection and try again.")).toBeTruthy();
    // The retry comes from the shared frame vocabulary, not a second catalog.
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();

    await pinLocale("zh-CN");
    expect(view.getByText("无法加载登录选项。")).toBeTruthy();
    expect(view.getByText("请检查你的网络连接后重试。")).toBeTruthy();

    // That retry is wired: once the connection answers, pressing it brings the ways in, in that language.
    const back = () =>
      Promise.resolve(
        Response.json({
          authProviders: ["google"],
          ssoConfigured: false,
          ssoRequired: false,
        }),
      );
    window.fetch = Object.assign(back, { preconnect: realFetch.preconnect });
    await user.click(view.getByRole("button", { name: "重试" }));
    expect(
      await view.findByRole("button", { name: "使用 Google 继续" }),
    ).toBeTruthy();
    expect(view.queryByText("无法加载登录选项。")).toBeNull();
  } finally {
    window.fetch = realFetch;
  }
});

test("every provider keeps its own name, in the interface language", async () => {
  const { view } = renderSignScreen({
    providers: ["google", "microsoft", "okta"],
    sso: false,
    ssoRequired: false,
  });
  await view.findByRole("heading", { name: "Sign in to OpenBot" });

  await pinLocale("zh-CN");
  expect(view.getByRole("button", { name: "使用 Google 继续" })).toBeTruthy();
  expect(
    view.getByRole("button", { name: "使用 Microsoft 继续" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "使用 Casdoor 继续" })).toBeTruthy();

  await pinLocale("en");
  expect(
    view.getByRole("button", { name: "Continue with Microsoft" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Continue with Casdoor" })).toBeTruthy();
});

/*
 * The first frame: whichever language the visit opens in, the sign page is already speaking it
 * before anyone touches a setting. `initI18n` is what main.tsx calls before rendering.
 */

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

test("the sign page speaks the browser's language from its first frame", async () => {
  const unSpeak = browserSpeaks(["zh-Hans-CN"]);
  try {
    localStorage.clear(); // no saved choice: the browser decides
    initI18n();

    const { view } = renderSignScreen({
      providers: ["google"],
      sso: false,
      ssoRequired: false,
    });
    expect(
      await view.findByRole("heading", { name: "登录 OpenBot" }),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "使用 Google 继续" })).toBeTruthy();
    // Even the tab is titled in the interface language before anyone switches anything.
    expect(document.title).toBe("登录 · OpenBot");
  } finally {
    unSpeak();
  }
});

test("a browser asking for Traditional Chinese reads the sign page in English", async () => {
  const unSpeak = browserSpeaks(["zh-Hant-TW"]);
  try {
    localStorage.clear();
    initI18n();

    const { view } = renderSignScreen({
      providers: ["google"],
      sso: false,
      ssoRequired: false,
    });
    expect(
      await view.findByRole("heading", { name: "Sign in to OpenBot" }),
    ).toBeTruthy();
    expect(document.title).toBe("Sign in · OpenBot");
  } finally {
    unSpeak();
  }
});

test("a language this browser kept decides the sign page's first frame over the browser's ask", async () => {
  localStorage.setItem("openbot-locale", "zh-CN");
  const unSpeak = browserSpeaks(["en-GB"]);
  try {
    initI18n();

    const { view } = renderSignScreen({
      providers: ["google"],
      sso: false,
      ssoRequired: false,
    });
    expect(
      await view.findByRole("heading", { name: "登录 OpenBot" }),
    ).toBeTruthy();
  } finally {
    unSpeak();
  }
});

test("an English this browser kept decides the sign page's first frame over a Chinese ask", async () => {
  localStorage.setItem("openbot-locale", "en");
  const unSpeak = browserSpeaks(["zh-Hans-CN"]);
  try {
    initI18n();

    const { view } = renderSignScreen({
      providers: ["google"],
      sso: false,
      ssoRequired: false,
    });
    expect(
      await view.findByRole("heading", { name: "Sign in to OpenBot" }),
    ).toBeTruthy();
    expect(document.title).toBe("Sign in · OpenBot");
  } finally {
    unSpeak();
  }
});
