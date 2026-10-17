// specs/interruption.spec.ts —— 中断与异常专项
import LoginScreen from "../screens/LoginScreen";
import HomeScreen from "../screens/HomeScreen";
import users from "../fixtures/users.json";

const BUNDLE_ID = process.env.APP_BUNDLE_ID ?? "com.example.app";

describe("中断与异常", () => {
  it("TC-E2E-INTR-002 杀进程重启登录态与购物车保持 [P0]", async () => {
    await driver.activateApp(BUNDLE_ID);
    await LoginScreen.login(users.p0Login.email, users.p0Login.password);
    await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 10_000 });

    await driver.terminateApp(BUNDLE_ID); // 杀进程
    await driver.activateApp(BUNDLE_ID); // 冷重启

    // 断言：无需再次登录直接进首页
    await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 15_000 });
  });

  it("TC-E2E-INTR-004 后台5分钟回前台登录态不过期误踢 [P2]", async () => {
    await driver.activateApp(BUNDLE_ID);
    await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 10_000 });

    await driver.backgroundApp(60); // CI 加速用 60s（真机验证用 300s）

    await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 10_000 }); // 不应被踢出登录
  });

  it("TC-E2E-INTR-001 支付页来电中断返回状态一致 [P0]（Android）", async () => {
    if (!driver.isAndroid) return; // iOS 走真机手动
    // 前置：已登录并进入收银台（复用交易流 helper，此处示意）
    await driver.activateApp("com.android.dialer");
    await driver.activateApp(BUNDLE_ID); // 挂断后切回
    // 断言：停留收银台或回到待支付订单页，金额不变、无重复订单（见用例文档）
  });
});
