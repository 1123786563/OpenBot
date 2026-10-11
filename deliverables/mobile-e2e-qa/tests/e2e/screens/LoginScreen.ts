// screens/LoginScreen.ts —— Page Object：登录屏
import { $ } from '@wdio/globals';

class LoginScreen {
  // 定位器集中声明；平台差异消化在 PO 层，用例层零感知
  get emailInput() {
    return driver.isAndroid
      ? $('android=new UiSelector().resourceId("com.example.app:id/email")')
      : $('~email_input');
  }
  get passwordInput() {
    return driver.isAndroid
      ? $('android=new UiSelector().resourceId("com.example.app:id/password")')
      : $('~password_input');
  }
  get loginButton() { return $('~login_button'); }
  get errorToast()  { return $('~login_error_toast'); }
  get rateLimitToast() { return $('~rate_limit_toast'); }

  async login(email: string, password: string) {
    await this.emailInput.waitForDisplayed({ timeout: 10_000 });
    await this.emailInput.setValue(email);
    await this.passwordInput.setValue(password);
    await this.loginButton.click();
  }
}
export default new LoginScreen();
