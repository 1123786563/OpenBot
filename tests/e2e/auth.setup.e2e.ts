import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Casdoor 本地开发账号（旧手写套件同款）。密码只有 3 位，低于框架 credentials/secrets 的
// 6 位下限（脱敏最小长度），走不了凭据机制，只能保持明文常量；快照里的密码框本身仍会被遮蔽。
const CASDOOR_USERNAME = "admin";
const CASDOOR_PASSWORD = "123";

test.setup(
  "authenticate as admin",
  { sessions: ["admin", "admin-auth"] },
  async ({ app, screen, session, browser }) => {
    // 登出会作废服务端会话；主套件与 auth 破坏性用例必须各持一份独立会话，
    // 否则 auth 文件跑完后，后续所有恢复 admin 会话的测试都会被送回 Casdoor。
    const signIn = async () => {
      await app.open("/");

      // 未登录访问会重定向到 Casdoor 登录页；两个输入框都有真实 <label>。
      await screen.getByLabel("Username").fill(CASDOOR_USERNAME);
      await screen.getByLabel("Password").fill(CASDOOR_PASSWORD);
      await screen.getByRole("button", "Sign In").tap();

      // OAuth 回调（3001）之后回到 3010；URL 回到应用且侧栏出现 Bots 才算登录成功。
      await expect(browser).toHaveURL(/localhost:3010/, { timeout: 20_000 });
      await expect(screen.getByRole("link", "Bots")).toBeVisible({
        timeout: 20_000,
      });
    };

    await signIn();
    await session.save("admin");

    // 只清浏览器状态、再登录一次：第一份服务端会话保持有效，两份保存态都可复用。
    // 不能用 Log out 分隔——那会作废已保存的 admin 会话，毒化后续所有测试。
    await app.clearState();
    await signIn();
    await session.save("admin-auth");
  },
);
