// helpers/selectors.ts —— 双平台定位器封装
// 规约：优先级 accessibility id > uiautomator/class chain > XPath（兜底）

type Selector = string;

/** 双平台条件选择：iOS 用 accessibilityId，Android 用 uiautomator */
export function crossPlatform(
  iosSelector: Selector,
  androidSelector: Selector,
): Selector {
  const isAndroid = driverIsAndroid();
  return isAndroid
    ? `-android uiautomator${androidSelector.replace("android=", "")}`
    : iosSelector;
}

export function driverIsAndroid(): boolean {
  // driver.capabilities 在 wdio 全局可用；此处简化判断
  return (
    !!(browser as any).isAndroid ??
    /android/i.test(JSON.stringify((browser as any).capabilities || {}))
  );
}

/** 简化取元素：默认 accessibility id（~ 前缀） */
export function byAccessibilityId(id: string): Selector {
  return `~${id}`;
}
