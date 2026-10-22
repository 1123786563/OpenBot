# ✗ Escape closes and restores focus to the trigger

`app/tests/h10-scratch-menu.test.tsx` · failed · 1.0s

**ASSERTION_FAILED**

```text
expected <div data-slot="context-menu-content" class="menu gap-0 p-0 outline-none" data-rac="" role="menu" tabindex="0" data-collection="react-aria207840483-_r_4h_"><div data-slot="context-menu-item" data-variant="default" class="menu-item menu-item--default group/context-menu-item relative flex min-h-0 cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-ob-hover-foreground data-[variant=destructive]:*:[svg]:text-destructive" data-rac="" id="react-aria207840483-_r_4m_" role="menuitem" aria-labelledby="react-aria207840483-_r_4j_" aria-describedby="react-aria207840483-_r_4k_ react-aria207840483-_r_4l_" tabindex="-1" data-collection="react-aria207840483-_r_4h_" data-key="react-aria-1" data-react-aria-pressable="true">Pin</div><div data-slot="context-menu-item" data-variant="default" class="menu-item menu-item--default group/context-menu-item relative flex min-h-0 cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-ob-hover-foreground data-[variant=destructive]:*:[svg]:text-destructive" data-rac="" id="react-aria207840483-_r_4q_" aria-disabled="true" role="menuitem" aria-labelledby="react-aria207840483-_r_4n_" aria-describedby="react-aria207840483-_r_4o_ react-aria207840483-_r_4p_" data-collection="react-aria207840483-_r_4h_" data-key="react-aria-2" data-react-aria-pressable="true" data-disabled="true">Disabled</div><div data-orientation="horizontal" data-slot="context-menu-separator" role="separator" class="separator separator--horizontal separator--default -mx-1 my-1 h-px bg-border"></div><div data-slot="context-menu-checkbox-item" class="menu-item menu-item--default relative flex min-h-0 cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*='size-'])]:size-4" data-rac="" id="react-aria207840483-_r_4u_" role="menuitemcheckbox" aria-labelledby="react-aria207840483-_r_4r_" aria-describedby="react-aria207840483-_r_4s_ react-aria207840483-_r_4t_" tabindex="-1" data-collection="react-aria207840483-_r_4h_" data-key="react-aria-4" data-react-aria-pressable="true" aria-checked="false"><span class="pointer-events-none absolute right-2" data-slot="context-menu-checkbox-item-indicator"></span>Show</div><section data-slot="context-menu-radio-group" class="menu-section" data-rac="" role="group" aria-labelledby="react-aria207840483-_r_4v_"><div data-slot="context-menu-radio-item" class="menu-item menu-item--default relative flex min-h-0 cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*='size-'])]:size-4" data-rac="" id="react-aria207840483-_r_53_" role="menuitemradio" aria-labelledby="react-aria207840483-_r_50_" aria-describedby="react-aria207840483-_r_51_ react-aria207840483-_r_52_" tabindex="-1" data-collection="react-aria207840483-_r_4h_" data-key="react-aria-5" data-react-aria-pressable="true" aria-checked="false"><span class="pointer-events-none absolute right-2" data-slot="context-menu-radio-item-indicator"></span>One</div><div data-slot="context-menu-radio-item" class="menu-item menu-item--default relative flex min-h-0 cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*='size-'])]:size-4" data-rac="" id="react-aria207840483-_r_57_" role="menuitemradio" aria-labelledby="react-aria207840483-_r_54_" aria-describedby="react-aria207840483-_r_55_ react-aria207840483-_r_56_" tabindex="-1" data-collection="react-aria207840483-_r_4h_" data-key="react-aria-6" data-react-aria-pressable="true" aria-checked="false"><span class="pointer-events-none absolute right-2" data-slot="context-menu-radio-item-indicator"></span>Two</div></section></div> to be null

Ignored nodes: comments, script, style
<html>
  <head />
  <body>
    <div
      aria-hidden="true"
    >
      <div
        class="select-none"
        data-slot="context-menu-trigger"
      >
        <button
          type="button"
        >
          row
        </button>
      </div>
    </div>
    <div
      aria-hidden="true"
      data-slot="context-menu-anchor"
      style="position: fixed; left: 0px; top: 0px; width: 1px; height: 1px; pointer-events: none;"
    />
    <span
      aria-hidden="true"
      data-focus-scope-start="true"
      hidden=""
    />
    <div
      aria-hidden="true"
      data-testid="underlay"
      style="position: fixed;"
    />
    <div
      style="display: contents;"
    >
      <div
        class="z-50 min-w-36 overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
        data-rac=""
        data-slot="context-menu-popover"
        data-trigger="ContextMenu"
        dir="ltr"
        style="position: fixed; top: 0px; left: 0px; z-index: 100000; max-height: 100vh;"
      >
        <div
          style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
        >
          <button
            aria-label="Dismiss"
            id="react-aria207840483-_r_4g_"
            style="width: 1px; height: 1px;"
            tabindex="-1"
          />
        </div>
        <template />
        <span
          data-focus-scope-start="true"
          hidden=""
        />
        <div
          class="menu gap-0 p-0 outline-none"
          data-collection="react-aria207840483-_r_4h_"
          data-rac=""
          data-slot="context-menu-content"
          role="menu"
          tabindex="0"
        >
          <div
            aria-describedby="react-aria207840483-_r_4k_ react-aria207840483-_r_4l_"
            aria-labelledby="react-aria207840483-_r_4j_"
            class="menu-item menu-item--default group/context-menu-item relative flex min-h-0 cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-ob-hover-foreground data-[variant=destructive]:*:[svg]:text-destructive"
            data-collection="react-aria207840483-_r_4h_"
            data-key="react-aria-1"
            data-rac=""
            data-react-aria-pressable="true"
            data-slot="con
```

Look at: `tests/support/e2e-compat.ts:132`  

<sub>e2e 0.20.0 · run `01a157f3-c558-756d-b8fb-51b5db947d02` · the whole run is in `report.json`</sub>
