# ✗ a row drawn as a disabled button is dimmed and takes no pointer

`app/tests/item-disabled.test.tsx` · failed · 3ms

**ASSERTION_FAILED**

```text
expected "group/item flex w-full flex-wrap items-center rounded-lg border dark:border-transparent text-sm transition-colors duration-100 outline-none focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:pointer-events-none disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 [a]:transition-colors [a]:hover:bg-ob-hover border-transparent gap-2.5 px-3 py-2.5" to contain "disabled:opacity-50"
```

Look at: `tests/support/e2e-compat.ts:132`  

<sub>e2e 0.20.0 · run `01a15a78-3340-7dd6-8da7-1f74bdbc9c31` · the whole run is in `report.json`</sub>
