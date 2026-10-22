# ✗ the current entry fails closed on non-http(s) schemes (fix-ocr24 `#1)` › a malformed pair (both empty-hostname schemes) never enters — the HIGH chain stays closed

`app/tests/craft-preview-tab.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find an element with the text: Opening the preview…. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

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

Look at: `app/tests/craft-preview-tab.test.tsx:1087`  

<sub>e2e 0.20.0 · run `01a15470-281e-7fbc-b1dc-6d3c0d7b40cc` · the whole run is in `report.json`</sub>
