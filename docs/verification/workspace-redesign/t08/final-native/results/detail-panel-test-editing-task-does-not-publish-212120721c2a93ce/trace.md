# ✗ editing task does not publish pending empty form and seeds after a breakpoint remount

`app/tests/detail-panel.test.tsx` · failed · 1.0s

**ERROR**

```text
Found multiple elements with the role "status"

Here are the matching elements:

Ignored nodes: comments, script, style
<output>
  wide
</output>

Ignored nodes: comments, script, style
<p
  class="mx-auto w-full max-w-xl p-8 text-sm text-muted-foreground"
  role="status"
>
  Loading scheduled tasks…
</p>

(If this is intentional, then use the `*AllBy*` variant of the query (like `queryAllByText`, `getAllByText`, or `findAllByText`)).

Ignored nodes: comments, script, style
<body>
  <div
    inert=""
  >
    <div
      class="flex h-full min-h-0"
    >
      <div
        class="flex flex-1 min-w-0 flex-col"
      >
        <output>
          wide
        </output>
      </div>
    </div>
  </div>
  <span
    data-focus-scope-start="true"
    hidden=""
    inert=""
  />
  <div
    class="drawer__backdrop drawer__backdrop--transparent bg-[var(--ob-backdrop)]"
    data-rac=""
    data-slot="sheet-overlay"
    style="--visual-viewport-width: 0px; --visual-viewport-height: 768px; --page-width: 0px; --page-height: 0px;"
  >
    <div
      class="drawer__content drawer__content--right"
      data-placement="right"
      data-rac=""
      data-slot="drawer-content"
    >
      <div
        style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
      >
        <button
          aria-label="Dismiss"
          id="react-aria-_r_6v_"
          style="width: 1px; height: 1px;"
          tabindex="-1"
        />
      </div>
      <section
        aria-labelledby="react-aria-_r_70_"
        class="drawer__dialog drawer__dialog--right flex flex-col rounded-2xl bg-overlay p-0 text-sm text-overlay-foreground shadow-lg h-full w-full max-w-none rounded-r-none border-l md:w-[min(24rem,calc(100vw-32px))] rounded-l-2xl gap-0"
        data-placement="right"
        data-rac=""
        data-side="right"
        data-slot="sheet-content"
        id="react-aria-_r_6t_"
        role="dialog"
        style="touch-action: auto; max-width: 100vw;"
        tabindex="-1"
      >
        <h2
          class="drawer__heading font-heading text-base font-medium text-foreground h-12 shrink-0 px-4 pr-12 flex items-center"
          data-slot="sheet-title"
          id="react-aria-_r_70_"
          slot="title"
        >
          Details
        </h2>
        <div
          class="flex-1 min-h-0 overflow-y-auto"
        >
          <p
            class="mx-auto w-full max-w-xl p-8 text-sm text-muted-foreground"
            role="status"
          >
            Loading scheduled tasks…
          </p>
        </div>
        <button
          class="button button--icon-only button--sm button--ghost group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] active:not-aria-[haspopup]:translate-y-px active:transform-none pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:pointer-events-none disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 hover:bg-ob-hover hover:text-foreground aria-expanded:bg-ob-hover aria-expanded:text-foreground size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg absolute top-3 right-3"
          data-rac=""
          data-react-aria-pressable="true"
          data-size="icon-sm"
          data-slot="sheet-close"
          data-variant="ghost"
          id="react-aria-_r_72_"
          slot="close"
          tabindex="0"
          type="button"
        >
          <svg
            class="tabler-icon tabler-icon-x "
            fill="none"
            height="24"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            viewBox="0 0 24 24"
            width="24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M18 6l-12 12"
            />
            <path
              d="M6 6l12 12"
            />
          </svg>
          <span
            class="sr-only"
          >
            Close
          </span>
        </button>
      </section>
    </div>
  </div>
  <span
    data-focus-scope-end="true"
    hidden=""
    inert=""
  />
</body>

Ignored nodes: comments, script, style
<html
  style="scrollbar-gutter: stable; overflow: hidden;"
>
  <head />
  <body>
    <div
      inert=""
    >
      <div
        class="flex h-full min-h-0"
      >
        <div
          class="flex flex-1 min-w-0 flex-col"
        >
          <output>
            wide
          </output>
        </div>
      </div>
    </div>
    <span
      data-focus-scope-start="true"
      hidden=""
      inert=""
    />
    <div
      class="drawer__backdrop drawer__backdrop--transparent bg-[var(--ob-backdrop)]"
      data-rac=""
      data-slot="sheet-overlay"
      style="--visual-viewport-width: 0px; --visual-viewport-height: 768px; --page-width: 0px; --page-height: 0px;"
    >
      <div
        class="drawer__content drawer__content--right"
        data-placement="right"
        data-rac=""
        data-slot="drawer-content"
      >
        <div
          style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
        >
          <button
            aria-label="Dismiss"
            id="react-aria-_r_6v_"
            style="width: 1px; height: 1px;"
            tabindex="-1"
          />
        </div>
        <section
          aria-labelledby="react-aria-_r_70_"
          class="drawer__dialog drawer__dialog--right flex flex-col rounded-2xl bg-overlay p-0 text-sm text-overlay-foreground shadow-lg h-full w-full max-w-none rounded-r-none border-l md:w-[min(24rem,calc(100vw-32px))] rounded-l-2xl gap-0"
          data-placement="right"
          data-rac=""
          data-side="right"
          data-slot="sheet-content"
          id="react-aria-_r_6t_"
          role="dialog"
          style="touch-action: auto; max-width: 100vw;"
          tabindex="-1"
        >
          <h2
            class="drawer__heading font-heading text-base font-medium text-foreground h-12 shrink-0 px-4 pr-12 flex items-center"
            data-slot="sheet-title"
            id="react-aria-_r_70_"
            slot="title"
          >
            Details
          </h2>
          <div
            class="flex-1 min-h-0 overflow-y-auto"
          >
            <p
              class="mx-auto w-full max-w-xl p-8 text-sm text-muted-foreground"
              role="status"
            >
              Loading scheduled tasks…
            </p>
          </div>
          <button
            class="button button--icon-only button--sm button--ghost group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] active:not-aria-[haspopup]:translate-y-px active:transform-none pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:pointer-events-none disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 hover:bg-ob-hover hover:text-foreground aria-expanded:bg-ob-hover aria-expanded:text-foreground size-7 rounded
```

Look at: `app/tests/detail-panel.test.tsx:341`  

<sub>e2e 0.20.0 · run `01a15a78-3340-7dd6-8da7-1f74bdbc9c31` · the whole run is in `report.json`</sub>
