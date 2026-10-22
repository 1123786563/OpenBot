import { test } from "@e2e-dev/web";

test("T01 rendered theme probe on the current local app", async ({
  browser,
}) => {
  await browser.goto("http://localhost:3011/", { waitUntil: "networkidle" });
  const result = await browser.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const style = getComputedStyle(root);
    const bodyStyle = getComputedStyle(body);
    return {
      url: `${location.origin}${location.pathname}`,
      title: document.title,
      lang: root.lang,
      theme: root.dataset.theme ?? root.className,
      bodyText: body.innerText.slice(0, 600),
      background: bodyStyle.backgroundColor,
      foreground: bodyStyle.color,
      accent: style.getPropertyValue("--ob-accent").trim(),
      muted: style.getPropertyValue("--ob-muted").trim(),
      field: style.getPropertyValue("--ob-field").trim(),
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      portals: document.querySelectorAll('[data-slot="popover-content"], [data-slot="listbox"]').length,
    };
  });
  console.log(`T01_BROWSER_PROBE ${JSON.stringify(result)}`);
});
