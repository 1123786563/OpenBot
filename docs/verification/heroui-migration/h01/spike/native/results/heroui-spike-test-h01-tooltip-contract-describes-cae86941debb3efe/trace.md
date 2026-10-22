# ✗ H01 Tooltip contract › describes its trigger and reveals content on keyboard focus

`app/tests/heroui-spike.test.tsx` · failed · 10ms

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
    id="react-aria5692125402-_r_21_"
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
  id="react-aria5692125402-_r_21_"
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
        id="react-aria5692125402-_r_21_"
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

<sub>e2e 0.20.0 · run `01a15441-9565-796f-a366-68a0202d3a4a` · the whole run is in `report.json`</sub>
