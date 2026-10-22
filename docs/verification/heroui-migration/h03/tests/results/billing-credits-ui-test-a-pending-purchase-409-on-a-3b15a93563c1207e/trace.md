# ✗ a pending-purchase 409 on a remounted dialog restores the blocking order so the cancel entry exists

`app/tests/billing-credits-ui.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find an element with the text: 连续包月. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

Ignored nodes: comments, script, style
<body>
  <div>
    <div
      role="dialog"
    >
      <div>
        <h2>
          Buddy AI 套餐
        </h2>
        <p>
          选择适合你的套餐与计费周期。
        </p>
        <div
          class="grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          <button
            class="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors border-primary ring-2 ring-primary/50"
            type="button"
          >
            <span
              class="font-medium"
            >
              标准版
            </span>
            <span
              class="text-lg font-semibold tabular-nums"
            >
              4,000
              <span
                class="text-muted-foreground ml-1 text-xs font-normal"
              >
                积分
              </span>
            </span>
            <ul
              class="text-muted-foreground space-y-1 text-xs"
            >
              <li>
                每月基础积分 4,000
              </li>
              <li>
                每月赠送积分
              </li>
              <li>
                全部模型可选
              </li>
              <li>
                无限次代码实时补全
              </li>
              <li>
                5 个自动任务
              </li>
            </ul>
          </button>
          <button
            class="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors border-border hover:border-muted-foreground"
            type="button"
          >
            <span
              class="font-medium"
            >
              高级版
            </span>
            <span
              class="text-lg font-semibold tabular-nums"
            >
              9,000
              <span
                class="text-muted-foreground ml-1 text-xs font-normal"
              >
                积分
              </span>
            </span>
            <ul
              class="text-muted-foreground space-y-1 text-xs"
            >
              <li>
                每月基础积分 9,000
              </li>
            </ul>
          </button>
          <button
            class="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors border-border hover:border-muted-foreground"
            type="button"
          >
            <span
              class="font-medium"
            >
              旗舰版
            </span>
            <span
              class="text-lg font-semibold tabular-nums"
            >
              50,000
              <span
                class="text-muted-foreground ml-1 text-xs font-normal"
              >
                积分
              </span>
            </span>
            <ul
              class="text-muted-foreground space-y-1 text-xs"
            >
              <li>
                每月基础积分 50,000
              </li>
            </ul>
          </button>
        </div>
        <p
          class="text-muted-foreground animate-pulse text-xs"
        >
          正在加载支付方式…
        </p>
        <div
          class="flex flex-col gap-4 sm:flex-row sm:items-start"
        >
          <div
            class="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg border border-dashed bg-ob-muted-surface/50 text-center"
          >
            <span
              class="text-muted-foreground text-xs"
            >
              扫码支付
            </span>
          </div>
          <div
            class="flex-1 space-y-1 text-sm"
          >
            <p
              class="font-medium"
            >
              标准版
               · 
              连续包月
            </p>
            <p
              class="tabular-nums"
            >
              ¥49
              <span
                class="text-muted-foreground"
              >
                /
                月
              </span>
            </p>
            <p
              class="text-muted-foreground text-xs"
            >
              有效期至 Nov 19, 2026
            </p>
            <p
              class="text-muted-foreground text-xs"
            >
              本月到期后如需续费请再次购买（自动续费尚未开通）
            </p>
          </div>
        </div>
        <label
          class="flex items-start gap-2 text-sm"
        >
          <input
            class="mt-0.5"
            type="checkbox"
          />
          <span>
            我已阅读并同意《服务协议》
          </span>
        </label>
        <button
          class="button button--md button--outline group/button inline-flex shrink-0 items-center justify-center rounded-lg border bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 border-border bg-background hover:bg-ob-muted-surface hover:text-foreground aria-expanded:bg-ob-muted-surface aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2"
          data-rac=""
          data-react-aria-pressable="true"
          data-size="default"
          data-slot="button"
          data-variant="outline"
          id="react-aria2023276286-_r_12_"
          tabindex="0"
          type="button"
        >
          取消
        </button>
        <button
          class="button button--md button--primary group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 bg-primary text-primary-foreground hover:bg-primary/80 h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2"
          data-disabled="true"
          data-rac=""
          data-react-aria-pressable="true"
          data-size="default"
          data-slot="button"
          data-variant="default"
          disabled=""
          id="react-aria2023276286-_r_14_"
          type="button"
        >
          同意协议并支付
        </button>
        <button
          type="button"
        >
          <span
            class="sr-only"
          >
            Close
          </span>
        </button>
      </div>
    </div>
  </div>
</body>

Ignored nodes: comments, script, style
<html>
  <head />
  <body>
    <div>
      <div
        role="dialog"
      >
        <div>
          <h2>
            Buddy AI 套餐
          </h2>
          <p>
            选择适合你的套餐与计费周期。
          </p>
          <div
            class="grid grid-cols-1 gap-3 sm:grid-cols-3"
          >
            <button
              class="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors border-primary ring-2 ring-primary/50"
              type="button"
            >
            
```

Look at: `app/tests/billing-credits-ui.test.tsx:652`  

<sub>e2e 0.20.0 · run `01a154a2-b157-798b-813e-60141f76e69f` · the whole run is in `report.json`</sub>
