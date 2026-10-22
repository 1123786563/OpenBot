# ✗ concurrent effect re-entries for the same address exchange ONCE — and the pass still lands

`app/tests/craft-preview-tab.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find an element with the title: Web app preview.

Ignored nodes: comments, script, style
<body>
  <div>
    <div
      class="flex h-full flex-col items-center justify-center gap-5 px-8 text-center"
    >
      <div
        class="w-full max-w-[300px] overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      >
        <div
          class="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-input px-4 py-8"
        >
          <p
            class="text-xs text-muted-foreground"
          >
            Opening the preview…
          </p>
        </div>
      </div>
      <p
        class="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground"
      >
        The web app is running; its one-time preview pass is being exchanged. If it does not open, check again for a fresh pass.
      </p>
      <button
        class="button button--sm button--outline group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 border-border bg-background hover:bg-ob-muted-surface hover:text-foreground aria-expanded:bg-ob-muted-surface aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5"
        data-disabled="true"
        data-rac=""
        data-react-aria-pressable="true"
        data-size="sm"
        data-slot="button"
        data-variant="outline"
        disabled=""
        id="react-aria8238854504-_r_0_"
        type="button"
      >
        Check again
      </button>
    </div>
  </div>
</body>

Ignored nodes: comments, script, style
<body>
  <div>
    <div
      class="flex h-full flex-col items-center justify-center gap-5 px-8 text-center"
    >
      <div
        class="w-full max-w-[300px] overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      >
        <div
          class="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-input px-4 py-8"
        >
          <p
            class="text-xs text-muted-foreground"
          >
            Opening the preview…
          </p>
        </div>
      </div>
      <p
        class="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground"
      >
        The web app is running; its one-time preview pass is being exchanged. If it does not open, check again for a fresh pass.
      </p>
      <button
        class="button button--sm button--outline group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 border-border bg-background hover:bg-ob-muted-surface hover:text-foreground aria-expanded:bg-ob-muted-surface aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5"
        data-disabled="true"
        data-rac=""
        data-react-aria-pressable="true"
        data-size="sm"
        data-slot="button"
        data-variant="outline"
        disabled=""
        id="react-aria8238854504-_r_0_"
        type="button"
      >
        Check again
      </button>
    </div>
  </div>
</body>
```

Look at: `app/tests/craft-preview-tab.test.tsx:1189`  

<sub>e2e 0.20.0 · run `01a15470-281e-7fbc-b1dc-6d3c0d7b40cc` · the whole run is in `report.json`</sub>
