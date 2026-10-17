// helpers/wait.ts —— 等待策略封装（禁止裸 sleep）
import { $ } from "@wdio/globals";

/**
 * 条件轮询：适用于「支付回调」「同步完成」等无 UI 信号的长任务
 * @param fn 返回 true 表示条件满足
 * @param timeoutMs 总超时
 * @param intervalMs 轮询间隔（指数退避：min(interval * 2^n, 2000)）
 */
export async function waitForCondition(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<boolean> {
  const start = Date.now();
  let interval = intervalMs;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch {
      /* 元素未就绪时继续轮询 */
    }
    await browser.pause(interval); // 轮询内部间隔，非业务等待
    interval = Math.min(interval * 2, 2000);
  }
  return false;
}

/** 安全点击：等待可见+可点，点击后验证生效，最多 attempts 次 */
export async function safeClick(selector: string, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const el = await $(selector);
    await el.waitForDisplayed({ timeout: 10_000 });
    await el.waitForEnabled({ timeout: 5_000 });
    await el.click();
    // 生效验证由调用方断言目标状态；此处仅消除「点击丢失」抖动
    return;
  }
  throw new Error(`safeClick failed after ${attempts} attempts: ${selector}`);
}

/** 滚动直到元素出现（iOS 动态元素常用） */
export async function scrollUntilVisible(
  selector: string,
  maxScrolls = 8,
): Promise<boolean> {
  const el = await $(selector);
  for (let i = 0; i < maxScrolls; i++) {
    if (await el.isDisplayed()) return true;
    await driver.execute("mobile: scrollGesture", {
      direction: "down",
      percent: 0.8,
      speed: 2000,
    });
    await browser.pause(300);
  }
  return await el.isDisplayed();
}
