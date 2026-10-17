// specs/order.spec.ts —— F3 交易流
import LoginScreen from "../screens/LoginScreen";
import HomeScreen from "../screens/HomeScreen";
import OrderScreens from "../screens/OrderScreens";
import { waitForCondition } from "../helpers/wait";
import users from "../fixtures/users.json";

const QA_API = process.env.QA_API ?? "https://qa-api.example.com";

describe("F3 交易流", () => {
  before(async () => {
    await driver.activateApp(process.env.APP_BUNDLE_ID ?? "com.example.app");
    await LoginScreen.login(users.orderUser.email, users.orderUser.password);
    await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 10_000 });
  });

  it("TC-E2E-ORDER-001 完整下单→沙箱支付→查单 [P0]", async () => {
    await HomeScreen.search("E2E-测试商品A");
    await OrderScreens.ProductDetail.buyNowButton.click();
    await expect(OrderScreens.OrderConfirm.amountText).toHaveText("¥9.90");
    await OrderScreens.OrderConfirm.payButton.click();
    await OrderScreens.OrderConfirm.sandboxPayOption.click();
    await OrderScreens.Cashier.paySuccessButton.click();

    // UI 断言
    await OrderScreens.OrderList.waitForStatus("已支付");

    // 状态断言（防 UI 假成功）：直连 QA API 校验后端
    const ok = await waitForCondition(async () => {
      const res = await fetch(
        `${QA_API}/test-hooks/last-order?email=${encodeURIComponent(users.orderUser.email)}`,
      );
      const order = await res.json();
      return order?.status === "paid" && order?.amount === 9.9;
    }, 30_000);
    expect(ok).toBe(true);
  });

  it("TC-E2E-ORDER-003 支付中途取消，订单停留待支付 [P0]", async () => {
    await HomeScreen.search("E2E-测试商品A");
    await OrderScreens.ProductDetail.buyNowButton.click();
    await OrderScreens.OrderConfirm.payButton.click();
    await OrderScreens.OrderConfirm.sandboxPayOption.click();
    await OrderScreens.Cashier.cancelButton.click();

    await OrderScreens.OrderList.waitForStatus("待支付");
  });
});
