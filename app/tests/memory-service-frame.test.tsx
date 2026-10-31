import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryServiceFrame } from "@/components/memory-service/frame";

/*
 * #731 承载页消息校验：精确 Origin、本 iframe 的 window、本次装载的 requestId
 * 三者齐备才处理；消息里的地址不被使用。宿主保留自己的侧栏——承载只有 iframe，
 * 且 sandbox 不含 allow-top-navigation（顶层导航由宿主自己做）。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const SRC = "https://memory.example/?embed=1&requestId=req-1";
const ORIGIN = "https://memory.example";
const REQUEST = "req-1";

function dispatch(options: {
  type: string;
  origin?: string;
  requestId?: string;
  source?: MessageEventSource | null;
  extra?: Record<string, unknown>;
}) {
  const event = new MessageEvent("message", {
    data: {
      type: options.type,
      requestId: options.requestId ?? REQUEST,
      ...options.extra,
    },
    origin: options.origin ?? ORIGIN,
    source: options.source ?? null,
  });
  window.dispatchEvent(event);
}

function mount(
  handlers: {
    onAuthRequired?: () => void;
    onLoggedOut?: () => void;
    navigate?: (url: string) => void;
  } = {},
) {
  const view = render(
    <MemoryServiceFrame
      src={SRC}
      allowedOrigin={ORIGIN}
      requestId={REQUEST}
      title="记忆"
      authFailedText="无法建立登录会话。"
      signedOutText="你已退出登录。"
      {...handlers}
    />,
  );
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  return { view, frame };
}

test("wrong_origin_or_window_is_ignored", async () => {
  const auth: string[] = [];
  const { frame } = mount({ onAuthRequired: () => auth.push("asked") });
  const source = frame.contentWindow;

  // 未允许的宿主 Origin：即使 source/requestId 都对，也丢弃。
  dispatch({
    type: "memory.auth-required",
    origin: "https://evil.example",
    source,
  });
  // 别人的 window（不是本 iframe）：同样丢弃。
  dispatch({ type: "memory.auth-required", source: window });
  // 上一次装载的 requestId：丢弃。
  dispatch({ type: "memory.auth-required", requestId: "old", source });
  // 未知消息类型：丢弃。
  dispatch({ type: "memory.login", source });
  expect(auth).toEqual([]);

  // 三件齐备才处理。
  dispatch({ type: "memory.auth-required", source });
  expect(auth).toEqual(["asked"]);

  // resize 被夹在承载页的最小/最大高度内，且只接受数字。
  const { frame: sized } = mount();
  dispatch({
    type: "memory.resize",
    source: sized.contentWindow,
    extra: { height: 900 },
  });
  await waitFor(() => expect(sized.style.height).toBe("900px"));
  dispatch({
    type: "memory.resize",
    source: sized.contentWindow,
    extra: { height: 10_000 },
  });
  await waitFor(() => expect(sized.style.height).toBe("2400px"));
  dispatch({
    type: "memory.resize",
    source: sized.contentWindow,
    extra: { height: "tall" },
  });
  await waitFor(() => expect(sized.style.height).toBe("2400px"));
});

test("auth_message_cannot_choose_return_url_or_user", () => {
  const auth: unknown[] = [];
  const { frame } = mount({
    onAuthRequired: (...args: unknown[]) => auth.push(args),
  });
  // 消息里塞了地址与身份：处理器不收任何参数，顶层回跳只到登记路由。
  dispatch({
    type: "memory.auth-required",
    source: frame.contentWindow,
    extra: {
      returnUrl: "https://evil.example/steal",
      subjectId: "someone-else",
    },
  });
  expect(auth).toEqual([[]]);
  // 承载页自身不接受顶层导航权限：导航只能由宿主发起。
  expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
});

test("logout_clears_embedded_state", async () => {
  let loggedOut = 0;
  const { view, frame } = mount({ onLoggedOut: () => (loggedOut += 1) });
  dispatch({ type: "memory.logged-out", source: frame.contentWindow });
  expect(loggedOut).toBe(1);
  // 承载页被清掉：内嵌状态不留在页面上，而不是一个仍在显示的旧界面。
  await waitFor(() => expect(view.queryByTitle("记忆")).toBeNull());
  expect(view.getByText("你已退出登录。")).toBeTruthy();
  // 伪造来源的退出消息不清任何状态，也不能冒充登录。
  dispatch({
    type: "memory.logged-out",
    origin: "https://evil.example",
    source: frame.contentWindow,
  });
  dispatch({ type: "memory.logged-out", source: window });
  expect(loggedOut).toBe(1);
});

test("default_login_goes_top_level_once_and_stops_instead_of_reloading", async () => {
  const navigations: string[] = [];
  const { view, frame } = mount({ navigate: (url) => navigations.push(url) });
  dispatch({ type: "memory.auth-required", source: frame.contentWindow });
  // 默认分支（页面实际走的那条）去记忆服务登记的 /auth/login，不是任意地址。
  expect(navigations).toEqual([`${ORIGIN}/auth/login`]);
  await waitFor(() => expect(view.queryByTitle("记忆")).not.toBeNull());

  // 会话仍建立不起来（存储受限等）：第二次只说明情况，不再重载宿主。
  dispatch({ type: "memory.auth-required", source: frame.contentWindow });
  expect(navigations).toHaveLength(1);
  await waitFor(() =>
    expect(view.getByText("无法建立登录会话。")).toBeTruthy(),
  );
});

test("frame_keeps_sidebar_and_has_no_second_navigation", () => {
  const { view, frame } = mount();
  // 承载内容只有 iframe 本身：没有重复的导航、标题栏或返回链接。
  expect(view.container.querySelectorAll("nav, header, aside")).toHaveLength(0);
  expect(frame.getAttribute("src")).toBe(SRC);
  const sandbox = frame.getAttribute("sandbox") ?? "";
  for (const disallowed of [
    "allow-top-navigation",
    "allow-popups-to-escape-sandbox",
  ]) {
    expect(sandbox).not.toContain(disallowed);
  }
});
