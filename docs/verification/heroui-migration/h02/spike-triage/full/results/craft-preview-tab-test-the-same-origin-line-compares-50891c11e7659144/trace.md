# ✗ the same-origin line compares hostnames, and the entry re-verifies what it navigates (fix-ocr6) › a server-sourced refusal keeps the server's own sentence across a language switch (fix-ocr27 `#10)`

`app/tests/craft-preview-tab.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find an element with the text: The sandbox is not available.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

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

Look at: `app/tests/craft-preview-tab.test.tsx:908`  

<sub>e2e 0.20.0 · run `01a15470-281e-7fbc-b1dc-6d3c0d7b40cc` · the whole run is in `report.json`</sub>
