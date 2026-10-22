# ✗ H01 Tooltip contract › describes its trigger and reveals content on keyboard focus

`app/tests/heroui-spike.test.tsx` · failed · 23ms

**ERROR**

```text
Found multiple elements with the role "button" and name "Hover me"

Here are the matching elements:

Ignored nodes: comments, script, style
<div
  class="tooltip__trigger"
  data-slot="tooltip-trigger"
  role="button"
  tabindex="0"
>
  <button
    class="button button--md button--primary"
    data-rac=""
    data-react-aria-pressable="true"
    data-slot="button"
    id="react-aria5881091083-_r_21_"
    tabindex="0"
    type="button"
  >
    Hover me
  </button>
</div>

Ignored nodes: comments, script, style
<button
  class="button button--md button--primary"
  data-rac=""
  data-react-aria-pressable="true"
  data-slot="button"
  id="react-aria5881091083-_r_21_"
  tabindex="0"
  type="button"
>
  Hover me
</button>

(If this is intentional, then use the `*AllBy*` variant of the query (like `queryAllByText`, `getAllByText`, or `findAllByText`)).

Ignored nodes: comments, script, style
<body>
  <div>
    <div
      class="tooltip__trigger"
      data-slot="tooltip-trigger"
      role="button"
      tabindex="0"
    >
      <button
        class="button button--md button--primary"
        data-rac=""
        data-react-aria-pressable="true"
        data-slot="button"
        id="react-aria5881091083-_r_21_"
        tabindex="0"
        type="button"
      >
        Hover me
      </button>
    </div>
  </div>
</body>
```

Look at: `app/tests/heroui-spike.test.tsx:370`  

<sub>e2e 0.20.0 · run `01a15442-1001-7a1a-9d23-3b71e7e6e14f` · the whole run is in `report.json`</sub>
