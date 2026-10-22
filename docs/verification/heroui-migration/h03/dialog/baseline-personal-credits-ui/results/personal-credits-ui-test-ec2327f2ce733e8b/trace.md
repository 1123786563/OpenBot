# ✗ 无发放记录时显示明确空态文案

`app/tests/personal-credits-ui.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find an element by: [data-testid="personal-balance"]

Ignored nodes: comments, script, style
<body>
  <div>
    <div
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <div
        class="mx-auto flex w-full flex-col px-6 pb-12 pt-12 max-w-5xl"
      >
        <header
          class="flex flex-col gap-2"
        >
          <div
            class="flex flex-row items-center justify-between gap-4"
          >
            <h1
              class="font-semibold text-display"
            >
              套餐与积分
            </h1>
          </div>
          <p
            class="max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed"
          >
            查看您的订阅套餐和账单信息
          </p>
        </header>
        <div
          class="mt-8"
        >
          <div
            class="relative rounded-xl border bg-card p-5"
          >
            <span
              class="bg-success/10 text-success absolute -top-2.5 left-4 rounded-full px-2.5 py-0.5 text-xs font-medium"
            >
              限时加赠 10/31截止
            </span>
            <div
              class="flex flex-wrap items-center justify-between gap-3"
            >
              <p
                class="text-sm"
              >
                欢迎体验 WorkBuddy，首月赠送个人标准版基础积分权益，快点击领取吧！
              </p>
              <span
                class="flex items-center gap-2"
              >
                <button
                  class="button button--sm button--primary group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/80 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5"
                  data-disabled="true"
                  data-rac=""
                  data-react-aria-pressable="true"
                  data-size="sm"
                  data-slot="button"
                  data-variant="default"
                  disabled=""
                  id="react-aria1434275533-_r_8_"
                  type="button"
                >
                  领取
                </button>
                <span
                  class="text-muted-foreground text-xs"
                >
                  领取功能即将开放
                </span>
              </span>
            </div>
          </div>
        </div>
        <section
          class="mt-12"
        >
          <div
            class="flex min-h-8 flex-row items-center justify-between gap-4"
          >
            <h2
              class="font-semibold text-lg"
            >
              订阅计划
            </h2>
          </div>
          <div
            class="skeleton skeleton--shimmer animate-pulse bg-ob-muted-surface motion-reduce:animate-none mt-4 h-40 w-full rounded-xl"
            data-slot="skeleton"
          />
        </section>
        <section
          class="mt-12"
        >
          <div
            class="flex min-h-8 flex-row items-center justify-between gap-4"
          >
            <h2
              class="font-semibold text-lg"
            >
              个人积分账户
            </h2>
          </div>
          <p
            class="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed"
          >
            您本人账户的积分余额，由平台按您的授权记录。
          </p>
          <div
            class="skeleton skeleton--shimmer animate-pulse bg-ob-muted-surface motion-reduce:animate-none mt-4 h-40 w-full rounded-xl"
            data-slot="skeleton"
          />
        </section>
        <section
          class="mt-12"
        >
          <div
            class="flex min-h-8 flex-row items-center justify-between gap-4"
          >
            <h2
              class="font-semibold text-lg"
            >
              购买积分
            </h2>
            <div
              class="flex flex-wrap items-center gap-3"
            >
              <span
                class="text-muted-foreground text-xs"
              >
                体验版限时开放至10月23日
              </span>
              <button
                class="button button--sm button--outline group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 border-border bg-background hover:bg-ob-muted-surface hover:text-foreground aria-expanded:bg-ob-muted-surface aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5"
                data-disabled="true"
                data-rac=""
                data-react-aria-pressable="true"
                data-size="sm"
                data-slot="button"
                data-variant="outline"
                disabled=""
                id="react-aria1434275533-_r_a_"
                type="button"
              >
                购买积分
              </button>
            </div>
          </div>
          <div
            class="rounded-xl border bg-card p-5"
          >
            <p
              class="text-muted-foreground text-sm"
            >
              暂无积分，购买后会展示在这里。
            </p>
          </div>
        </section>
        <section
          class="mt-12"
        >
          <div
            class="flex min-h-8 flex-row items-center justify-between gap-4"
          >
            <h2
              class="font-semibold text-lg"
            >
              平台奖励积分
            </h2>
          </div>
          <p
            class="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed"
          >
            平台活动与签到发放的奖励积分，按到期时间先后排列。
          </p>
          <div
            class="skeleton skeleton--shimmer animate-pulse bg-ob-muted-surface motion-reduce:animate-none mt-4 h-32 w-full rounded-xl"
            data-slot="skeleton"
          />
        </section>
        <section
          class="mt-12"
        >
          <div
            class="flex min-h-8 flex-row items-center justify-between gap-4"
          >
            <h2
              class="font-semibold text-lg"
            >
              积分消耗明细
            </h2>
          </div>
          <p
            class="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed"
          >
            每一笔积分消耗的明细，按时间倒序。
          </p>
          <div
            class="skeleton skeleton--shimmer animate-pulse bg-ob-muted-surface motion-reduce:animate-none mt-4 h-60 w-full rounded-xl"
            data-slot="skeleton"
          />
        </section>

```

Look at: `app/tests/personal-credits-ui.test.tsx:454`  

<sub>e2e 0.20.0 · run `01a1549d-0fb0-7db3-ad44-6c81d3a1cfbb` · the whole run is in `report.json`</sub>
