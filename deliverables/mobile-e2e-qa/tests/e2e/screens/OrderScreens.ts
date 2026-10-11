// screens/OrderScreens.ts —— Page Object：交易流（详情/确认/收银台/订单列表）
import { $ } from '@wdio/globals';
import { scrollUntilVisible } from '../helpers/wait';

class ProductDetailScreen {
  get buyNowButton()  { return $('~buy_now_button'); }
  get priceText()     { return $('~product_price'); }
}

class OrderConfirmScreen {
  get amountText()    { return $('~order_amount'); }
  get payButton()     { return $('~go_pay_button'); }
  get sandboxPayOption() { return $('~pay_option_sandbox'); }
}

class CashierScreen {
  get paySuccessButton() { return $('~sandbox_pay_success'); }
  get cancelButton()     { return $('~sandbox_pay_cancel'); }
}

class OrderListScreen {
  get firstOrderStatus()  { return $('~order_item_status_0'); }
  get firstOrderAmount()  { return $('~order_item_amount_0'); }

  async waitForStatus(status: string, timeout = 15_000) {
    return scrollUntilVisible(`~order_item_status_0`).then(async () => {
      const el = await this.firstOrderStatus;
      await el.waitUntil(async () => (await el.getText()).includes(status), { timeout });
    });
  }
}

export default {
  ProductDetail: new ProductDetailScreen(),
  OrderConfirm: new OrderConfirmScreen(),
  Cashier: new CashierScreen(),
  OrderList: new OrderListScreen(),
};
