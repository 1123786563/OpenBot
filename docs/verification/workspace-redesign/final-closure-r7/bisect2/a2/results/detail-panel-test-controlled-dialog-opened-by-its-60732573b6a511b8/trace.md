# ✗ controlled dialog opened by its owner restores focus to the invoking control

`app/tests/detail-panel.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find role="dialog" and name "Credential"

Ignored nodes: comments, script, style
<body>
  <div>
    <button
      type="button"
    >
      Add credential
    </button>
    <div
      role="dialog"
    >
      <div>
        <h2>
          Credential
        </h2>
        Close
        <button
          type="button"
        >
          <span
            class="sr-only"
          >
            Close
          </span>
        </button>
      </div>
    </div>
  </div>
</body>

Ignored nodes: comments, script, style
<body>
  <div>
    <button
      type="button"
    >
      Add credential
    </button>
    <div
      role="dialog"
    >
      <div>
        <h2>
          Credential
        </h2>
        Close
        <button
          type="button"
        >
          <span
            class="sr-only"
          >
            Close
          </span>
        </button>
      </div>
    </div>
  </div>
</body>
```

Look at: `app/tests/detail-panel.test.tsx:336`  

<sub>e2e 0.20.0 · run `01a16447-125d-77cc-86e8-6d27bd8e1e09` · the whole run is in `report.json`</sub>
