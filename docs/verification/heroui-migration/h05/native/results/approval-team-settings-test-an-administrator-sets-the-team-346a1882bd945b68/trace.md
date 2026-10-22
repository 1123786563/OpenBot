# ✗ an administrator sets the team-wide controls

`app/tests/approval-team-settings.test.tsx` · failed · 73ms

**ERROR**

```text
Unable to find an accessible element with the role "combobox" and name "Commands on members' computers, at most"

Here are the accessible roles:

  heading:

  Name "Team settings":
  <h2
    class="font-semibold text-lg"
  />

  Name "Team rules":
  <h2
    class="font-semibold text-lg"
  />

  --------------------------------------------------
  switch:

  Name "Require auto-review for everyone":
  <input
    aria-checked="true"
    aria-labelledby="enforce-auto-review-title"
    checked=""
    data-checked=""
    data-react-aria-pressable="true"
    role="switch"
    tabindex="0"
    title=""
    type="checkbox"
  />

  Name "Let members set personal rules":
  <input
    aria-checked="true"
    aria-labelledby="custom-rules-title"
    checked=""
    data-checked=""
    data-react-aria-pressable="true"
    role="switch"
    tabindex="0"
    title=""
    type="checkbox"
  />

  --------------------------------------------------
  separator:

  Name "":
  <hr
    class="separator separator--horizontal separator--default shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch"
    data-orientation="horizontal"
    data-slot="separator"
    role="separator"
  />

  Name "":
  <hr
    class="separator separator--horizontal separator--default shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch"
    data-orientation="horizontal"
    data-slot="separator"
    role="separator"
  />

  Name "":
  <hr
    class="separator separator--horizontal separator--default shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch"
    data-orientation="horizontal"
    data-slot="separator"
    role="separator"
  />

  --------------------------------------------------
  paragraph:

  Name "":
  <p
    class="line-clamp-2 text-left text-sm leading-normal font-normal text-muted-foreground group-data-[size=xs]/item:text-xs [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary"
    data-slot="item-description"
  />

  Name "":
  <p
    class="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed"
  />

  Name "":
  <p
    class="line-clamp-2 text-left text-sm leading-normal font-normal text-muted-foreground group-data-[size=xs]/item:text-xs [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary"
    data-slot="item-description"
  />

  --------------------------------------------------
  button:

  Name "Commands on members' computers, at most":
  <button
    aria-expanded="false"
    aria-haspopup="listbox"
    aria-label="Commands on members' computers, at most"
    aria-labelledby="react-aria3056267676-_r_b_"
    class="select__trigger flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
    data-rac=""
    data-react-aria-pressable="true"
    data-size="default"
    data-slot="select-trigger"
    id="react-aria3056267676-_r_6_"
    tabindex="0"
    type="button"
  />

  Name "Behaviour for mcp/drive/share":
  <button
    aria-expanded="false"
    aria-haspopup="listbox"
    aria-label="Behaviour for mcp/drive/share"
    aria-labelledby="react-aria3056267676-_r_l_"
    class="select__trigger flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
    data-rac=""
    data-react-aria-pressable="true"
    data-size="default"
    data-slot="select-trigger"
    id="react-aria3056267676-_r_g_"
    tabindex="0"
    type="button"
  />

  Name "Remove":
  <button
    class="button button--sm button--outline group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 border-border bg-background hover:bg-ob-muted-surface hover:text-foreground aria-expanded:bg-ob-muted-surface aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5"
    data-rac=""
    data-react-aria-pressable="true"
    data-size="sm"
    data-slot="button"
    data-variant="outline"
    id="react-aria3056267676-_r_o_"
    tabindex="0"
    type="button"
  />

  Name "Add a team rule A tool or app, and what a Bot does before using it.":
  <button
    class="group/item flex w-full flex-wrap items-center rounded-lg border dark:border-transparent text-sm transition-colors duration-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [a]:transition-colors [a]:hover:bg-ob-muted-surface border-transparent gap-2.5 px-3 py-2.5"
    data-size="sm"
    data-slot="item"
    data-variant="default"
    type="button"
  />

  --------------------------------------------------

Ignored nodes: comments, script, style
<body>
  <div>
    <section
      class="mt-12"
    >
      <div
        class="flex min-h-8 flex-row items-center justify-between gap-4"
      >
        <h2
          class="font-semibold text-lg"
        >
          Team settings
        </h2>
      </div>
      <div
        class="mt-4 overflow-hidden rounded-2xl border border-border bg-card shadow-card dark:border-transparent dark:shadow-none [&_[data-slot=item]]:rounded-none"
      >
        <div
          class="group/item flex w-full flex-wrap items-center rounded-lg border dark:border-transparent text-sm transition-colors duration-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [a]:transition-colors [a]:hover:bg-ob-muted-surface border-transparent gap-2.5 px-3 py-2.5"
          data-size="sm"
          data-slot="item"
          data-variant="default"
        >
          <div
            class=
```

Look at: `app/tests/approval-team-settings.test.tsx:123`  

<sub>e2e 0.20.0 · run `01a157b0-cc0e-7112-994c-6464c93a24eb` · the whole run is in `report.json`</sub>
