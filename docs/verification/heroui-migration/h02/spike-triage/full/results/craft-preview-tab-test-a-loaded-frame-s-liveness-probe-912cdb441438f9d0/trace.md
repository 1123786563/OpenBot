# ✗ a loaded frame's liveness probe catches the restart-dead entry (fix-ocr12, same-origin probe per fix-ocr13) › fix-ocr25 `#1:` the 204 probe reads the main site — the preview source gets its own no-cors verdict › a 204 probe over a dead preview source drops the entry — the no-cors reject rides the counted brake (fix-ocr25 `#1)`

`app/tests/craft-preview-tab.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find an element with the title: Web app preview.

Ignored nodes: comments, script, style
<body>
  <div>
    <p
      class="p-4 text-sm text-muted-foreground"
    >
      Checking for a web app…
    </p>
  </div>
</body>

Ignored nodes: comments, script, style
<body>
  <div>
    <p
      class="p-4 text-sm text-muted-foreground"
    >
      Checking for a web app…
    </p>
  </div>
</body>
```

Look at: `app/tests/craft-preview-tab.test.tsx:2119`  

<sub>e2e 0.20.0 · run `01a15470-281e-7fbc-b1dc-6d3c0d7b40cc` · the whole run is in `report.json`</sub>
