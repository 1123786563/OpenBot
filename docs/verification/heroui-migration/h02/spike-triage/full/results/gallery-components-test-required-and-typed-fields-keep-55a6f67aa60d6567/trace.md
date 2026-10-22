# ✗ required and typed fields keep the form pending until corrected

`app/tests/gallery-components.test.tsx` · failed · 738ms

**ERROR**

```text
Unable to find an element with the text: Enter a valid email address.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

Ignored nodes: comments, script, style
<body>
  <div>
    <figure
      class="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
    >
      <figcaption
        class="flex items-start justify-between gap-4 border-b border-border px-4 py-3"
      >
        <div
          class="min-w-0"
        >
          <p
            class="truncate text-sm font-medium"
          >
            Project brief
          </p>
        </div>
        <div
          class="shrink-0"
        >
          <span
            class="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 dark:bg-amber-500/15"
          >
            Waiting on you
          </span>
        </div>
      </figcaption>
      <div
        class="px-4 py-3"
      >
        <form
          aria-label="Project brief"
          class="space-y-4"
          novalidate=""
        >
          <p
            class="text-xs text-muted-foreground"
          >
            Fields marked * are required. Your answers will be shared with the Bot.
          </p>
          <div
            class="space-y-1.5"
          >
            <label
              class="block text-sm font-medium"
              for="_r_1q_-team"
            >
              Team
              <span
                aria-hidden="true"
                class="ml-1 text-muted-foreground"
              >
                *
              </span>
            </label>
            <input
              aria-invalid="false"
              class="input input--primary h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none shadow-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:bg-transparent focus:bg-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:bg-transparent aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
              data-rac=""
              data-slot="input"
              id="_r_1q_-team"
              maxlength="2000"
              name="team"
              required=""
              type="text"
              value="  Design  "
            />
          </div>
          <div
            class="space-y-1.5"
          >
            <label
              class="block text-sm font-medium"
              for="_r_1q_-email"
            >
              Work email
              <span
                aria-hidden="true"
                class="ml-1 text-muted-foreground"
              >
                *
              </span>
            </label>
            <input
              aria-invalid="false"
              class="input input--primary h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none shadow-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:bg-transparent focus:bg-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:bg-transparent aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
              data-rac=""
              data-slot="input"
              id="_r_1q_-email"
              maxlength="2000"
              name="email"
              required=""
              type="email"
              value="designer@example.testinvalid"
            />
          </div>
          <div
            class="space-y-1.5"
          >
            <label
              class="block text-sm font-medium"
              for="_r_1q_-seats"
            >
              Seats
              <span
                aria-hidden="true"
                class="ml-1 text-muted-foreground"
              >
                *
              </span>
            </label>
            <input
              aria-describedby="_r_1q_-seats-error"
              aria-invalid="true"
              class="input input--primary h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none shadow-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:bg-transparent focus:bg-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:bg-transparent aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
              data-focus-visible="true"
              data-focused="true"
              data-invalid="true"
              data-rac=""
              data-slot="input"
              id="_r_1q_-seats"
              max="20"
              maxlength="2000"
              min="1"
              name="seats"
              required=""
              step="any"
              type="number"
              value="321"
            />
            <p
              class="text-xs text-destructive"
              id="_r_1q_-seats-error"
              role="alert"
            >
              Enter 20 or less.
            </p>
          </div>
          <div
            class="space-y-1.5"
          >
            <label
              class="block text-sm font-medium"
              for="_r_1q_-priority"
            >
              Priority
              <span
                aria-hidden="true"
                class="ml-1 text-muted-foreground"
              >
                *
              </span>
            </label>
            <select
              aria-invalid="false"
              class="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              id="_r_1q_-priority"
              name="priority"
              required=""
            >
              <option
                value=""
              >
                Choose an option
              </option>
              <option
                value="This week"
              >
                This week
              </option>
              <option
                value="This month"
              >
                This month
              </option>
            </select>
          </div>
          <div
            class="space-y-1.5"
          >
            <label
              class="block text-sm font-medium"
              for="_r_1q_-notes"
            >
              Notes
            </label>
            <textarea
              aria-invalid="false"
              class="textarea textarea--primary flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none shadow-none placeholder:text-muted-foreground hover:bg-transparent focus:bg-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:bg-transparent aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-in
```

Look at: `app/tests/gallery-components.test.tsx:135`  

<sub>e2e 0.20.0 · run `01a15470-281e-7fbc-b1dc-6d3c0d7b40cc` · the whole run is in `report.json`</sub>
