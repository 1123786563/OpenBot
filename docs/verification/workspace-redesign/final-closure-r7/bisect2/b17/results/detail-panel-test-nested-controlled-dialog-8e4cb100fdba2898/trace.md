# ✗ nested controlled dialog restores focus to a trigger inside its parent dialog

`app/tests/detail-panel.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find role="dialog" and name "Inner dialog"

Ignored nodes: comments, script, style
<body>
  <div>
    <div
      role="dialog"
    >
      <div>
        <h2>
          Outer dialog
        </h2>
        <button
          type="button"
        >
          Open nested dialog
        </button>
        <div
          role="dialog"
        >
          <div>
            <h2>
              Inner dialog
            </h2>
            Close inner
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
    <div
      role="dialog"
    >
      <div>
        <h2>
          Outer dialog
        </h2>
        <button
          type="button"
        >
          Open nested dialog
        </button>
        <div
          role="dialog"
        >
          <div>
            <h2>
              Inner dialog
            </h2>
            Close inner
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

Look at: `app/tests/detail-panel.test.tsx:371`  

<sub>e2e 0.20.0 · run `01a16446-003c-700f-aae1-8effa3af1d2a` · the whole run is in `report.json`</sub>
