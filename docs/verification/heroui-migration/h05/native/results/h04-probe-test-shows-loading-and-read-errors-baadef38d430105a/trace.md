# ✗ shows loading and read errors without enabling a save

`app/tests/h04-probe.test.tsx` · failed · 23ms

**ERROR**

```text
Unable to find an accessible element with the role "combobox"

Here are the accessible roles:

  paragraph:

  Name "":
  <p
    class="line-clamp-2 text-left text-sm leading-normal font-normal text-muted-foreground group-data-[size=xs]/item:text-xs [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary"
    data-slot="item-description"
  />

  --------------------------------------------------
  button:

  Name "Message list emphasis":
  <button
    aria-expanded="false"
    aria-haspopup="listbox"
    aria-label="Message list emphasis"
    aria-labelledby="react-aria9805942953-_r_i_"
    class="select__trigger flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
    data-disabled="true"
    data-placeholder=""
    data-rac=""
    data-react-aria-pressable="true"
    data-size="default"
    data-slot="select-trigger"
    disabled=""
    id="react-aria9805942953-_r_d_"
    type="button"
  />

  --------------------------------------------------

Ignored nodes: comments, script, style
<body>
  <div>
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
          class="flex flex-1 flex-col gap-1 group-data-[size=xs]/item:gap-0 [&+[data-slot=item-content]]:flex-none"
          data-slot="item-content"
        >
          <div
            class="line-clamp-1 flex w-fit items-center gap-2 text-sm leading-snug font-medium underline-offset-4"
            data-slot="item-title"
          >
            Message list emphasis
          </div>
          <p
            class="line-clamp-2 text-left text-sm leading-normal font-normal text-muted-foreground group-data-[size=xs]/item:text-xs [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary"
            data-slot="item-description"
          >
            Choose which name appears larger in the sidebar.
          </p>
        </div>
        <div
          class="flex items-center gap-2"
          data-slot="item-actions"
        >
          <template />
          <div
            class="select select--primary"
            data-disabled="true"
            data-rac=""
            data-slot="select-root"
          >
            <button
              aria-expanded="false"
              aria-haspopup="listbox"
              aria-label="Message list emphasis"
              aria-labelledby="react-aria9805942953-_r_i_"
              class="select__trigger flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
              data-disabled="true"
              data-placeholder=""
              data-rac=""
              data-react-aria-pressable="true"
              data-size="default"
              data-slot="select-trigger"
              disabled=""
              id="react-aria9805942953-_r_d_"
              type="button"
            >
              <span
                class="flex flex-1 text-left"
                data-placeholder=""
                data-slot="select-value"
              >
                Loading…
              </span>
              <svg
                class="tabler-icon tabler-icon-selector pointer-events-none size-4 text-muted-foreground"
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
                  d="M8 9l4 -4l4 4"
                />
                <path
                  d="M16 15l-4 4l-4 -4"
                />
              </svg>
            </button>
            <div
              aria-hidden="true"
              data-a11y-ignore="aria-hidden-focus"
              data-react-aria-prevent-focus="true"
              data-testid="hidden-select-container"
              style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: fixed; width: 1px; white-space: nowrap; top: 0px; left: 0px;"
            >
              <label>
                <select
                  disabled=""
                  tabindex="-1"
                >
                  <option
                    label=" "
                    value=""
                  >
                     
                  </option>
                  <option
                    value="s:thread"
                  >
                    Thread title
                  </option>
                  <option
                    value="s:agent"
                  >
                    Agent name
                  </option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
```

Look at: `app/tests/h04-probe.test.tsx:78`  

<sub>e2e 0.20.0 · run `01a157b0-cc0e-7112-994c-6464c93a24eb` · the whole run is in `report.json`</sub>
