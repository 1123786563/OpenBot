# ✗ fix-ocr26 `#3:` the cancelled exchange's catch holds the guard too › a rejection from a cancelled run never renders its refusal over the new run's state

`app/tests/craft-preview-tab.test.tsx` · failed · 1.0s

**ASSERTION_FAILED**

```text
expected 0 to be 1

Ignored nodes: comments, script, style
<html>
  <head />
  <body>
    <div>
      <p
        class="p-4 text-sm text-muted-foreground"
      >
        Checking for a web app…
      </p>
    </div>
  </body>
</html>
```

Look at: `tests/support/e2e-compat.ts:132`  

<sub>e2e 0.20.0 · run `01a15470-281e-7fbc-b1dc-6d3c0d7b40cc` · the whole run is in `report.json`</sub>
