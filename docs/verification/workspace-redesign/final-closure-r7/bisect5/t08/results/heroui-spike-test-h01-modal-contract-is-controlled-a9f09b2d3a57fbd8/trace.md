# ✗ H01 Modal contract › is controlled by isOpen and emits onOpenChange on ESC

`app/tests/heroui-spike.test.tsx` · failed · 1.0s

**ASSERTION_FAILED**

```text
expected <section id="react-aria-_r_9_" data-placement="auto" data-slot="modal-dialog" class="modal__dialog modal__dialog--scroll-inside modal__dialog--md" data-rac="" aria-labelledby="react-aria-_r_c_" role="dialog" tabindex="-1"><div class="modal__header" data-slot="modal-header"><h2 id="react-aria-_r_c_" data-slot="modal-heading" slot="title" class="modal__heading">Spike dialog</h2></div><div class="modal__body modal__body--scroll-inside" data-slot="modal-body"><p>Body</p></div><div class="modal__footer" data-slot="modal-footer"><button data-slot="modal-close-trigger" class="close-button close-button--default modal__close-trigger" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" aria-label="Close" id="react-aria-_r_e_" slot="close">Close</button></div></section> to be null

Ignored nodes: comments, script, style
<html>
  <head />
  <body>
    <div>
      <button
        class="button button--md button--primary"
        data-rac=""
        data-react-aria-pressable="true"
        data-slot="button"
        id="react-aria-_r_7_"
        tabindex="0"
        type="button"
      >
        Open
      </button>
    </div>
    <span
      data-focus-scope-start="true"
      hidden=""
    />
    <div
      class="modal__backdrop modal__backdrop--opaque"
      data-exiting="true"
      data-rac=""
      data-slot="modal-backdrop"
      style="--visual-viewport-width: 0px; --visual-viewport-height: 0px; --page-width: 0px; --page-height: 0px;"
    >
      <div
        class="modal__container"
        data-exiting="true"
        data-placement="auto"
        data-rac=""
        data-slot="modal-container"
      >
        <div
          style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
        >
          <button
            aria-label="Dismiss"
            id="react-aria-_r_b_"
            style="width: 1px; height: 1px;"
            tabindex="-1"
          />
        </div>
        <section
          aria-labelledby="react-aria-_r_c_"
          class="modal__dialog modal__dialog--scroll-inside modal__dialog--md"
          data-placement="auto"
          data-rac=""
          data-slot="modal-dialog"
          id="react-aria-_r_9_"
          role="dialog"
          tabindex="-1"
        >
          <div
            class="modal__header"
            data-slot="modal-header"
          >
            <h2
              class="modal__heading"
              data-slot="modal-heading"
              id="react-aria-_r_c_"
              slot="title"
            >
              Spike dialog
            </h2>
          </div>
          <div
            class="modal__body modal__body--scroll-inside"
            data-slot="modal-body"
          >
            <p>
              Body
            </p>
          </div>
          <div
            class="modal__footer"
            data-slot="modal-footer"
          >
            <button
              aria-label="Close"
              class="close-button close-button--default modal__close-trigger"
              data-rac=""
              data-react-aria-pressable="true"
              data-slot="modal-close-trigger"
              id="react-aria-_r_e_"
              slot="close"
              tabindex="0"
              type="button"
            >
              Close
            </button>
          </div>
        </section>
      </div>
       
    </div>
    <span
      data-focus-scope-end="true"
      hidden=""
    />
  </body>
</html>
```

Look at: `tests/support/e2e-compat.ts:132`  

<sub>e2e 0.20.0 · run `01a16457-7272-7d38-ae2d-2203b3edc681` · the whole run is in `report.json`</sub>
