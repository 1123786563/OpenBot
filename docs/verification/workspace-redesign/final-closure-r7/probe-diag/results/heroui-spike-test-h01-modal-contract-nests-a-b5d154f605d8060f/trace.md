# ✗ H01 Modal contract › nests a second dialog and closes only the top layer on ESC

`app/tests/heroui-spike.test.tsx` · failed · 1.0s

**ERROR**

```text
Unable to find role="dialog" and name "Outer"

Ignored nodes: comments, script, style
<body>
  <div
    aria-hidden="true"
  />
  <span
    aria-hidden="true"
    data-focus-scope-start="true"
    hidden=""
  />
  <div
    aria-hidden="true"
    class="modal__backdrop modal__backdrop--opaque"
    data-rac=""
    data-slot="modal-backdrop"
    style="--visual-viewport-width: 0px; --visual-viewport-height: 0px; --page-width: 0px; --page-height: 0px;"
  >
    <div
      class="modal__container"
      data-placement="auto"
      data-rac=""
      data-slot="modal-container"
    >
      <div
        style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
      >
        <button
          aria-label="Dismiss"
          id="react-aria-_r_37_"
          style="width: 1px; height: 1px;"
          tabindex="-1"
        />
      </div>
      <section
        aria-label="Inner"
        class="modal__dialog modal__dialog--scroll-inside modal__dialog--md"
        data-placement="auto"
        data-rac=""
        data-slot="modal-dialog"
        id="react-aria-_r_35_"
        role="dialog"
        tabindex="-1"
      >
        <h2
          class="modal__heading"
          data-slot="modal-heading"
          slot="title"
        >
          Inner
        </h2>
        <div
          class="modal__body modal__body--scroll-inside"
          data-slot="modal-body"
        >
          inner body
        </div>
      </section>
    </div>
     
  </div>
  <span
    aria-hidden="true"
    data-focus-scope-end="true"
    hidden=""
  />
  <span
    aria-hidden="true"
    data-focus-scope-start="true"
    hidden=""
  />
  <div
    aria-hidden="true"
    class="modal__backdrop modal__backdrop--opaque"
    data-rac=""
    data-slot="modal-backdrop"
    style="--visual-viewport-width: 0px; --visual-viewport-height: 0px; --page-width: 0px; --page-height: 0px;"
  >
    <div
      class="modal__container"
      data-placement="auto"
      data-rac=""
      data-slot="modal-container"
    >
      <div
        style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
      >
        <button
          aria-label="Dismiss"
          id="react-aria-_r_32_"
          style="width: 1px; height: 1px;"
          tabindex="-1"
        />
      </div>
      <section
        aria-label="Outer"
        class="modal__dialog modal__dialog--scroll-inside modal__dialog--md"
        data-placement="auto"
        data-rac=""
        data-slot="modal-dialog"
        id="react-aria-_r_30_"
        role="dialog"
        tabindex="-1"
      >
        <h2
          class="modal__heading"
          data-slot="modal-heading"
          slot="title"
        >
          Outer
        </h2>
        <div
          class="modal__body modal__body--scroll-inside"
          data-slot="modal-body"
        />
      </section>
    </div>
     
  </div>
  <span
    aria-hidden="true"
    data-focus-scope-end="true"
    hidden=""
  />
</body>

Ignored nodes: comments, script, style
<body>
  <div
    aria-hidden="true"
  />
  <span
    aria-hidden="true"
    data-focus-scope-start="true"
    hidden=""
  />
  <div
    aria-hidden="true"
    class="modal__backdrop modal__backdrop--opaque"
    data-rac=""
    data-slot="modal-backdrop"
    style="--visual-viewport-width: 0px; --visual-viewport-height: 0px; --page-width: 0px; --page-height: 0px;"
  >
    <div
      class="modal__container"
      data-placement="auto"
      data-rac=""
      data-slot="modal-container"
    >
      <div
        style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
      >
        <button
          aria-label="Dismiss"
          id="react-aria-_r_37_"
          style="width: 1px; height: 1px;"
          tabindex="-1"
        />
      </div>
      <section
        aria-label="Inner"
        class="modal__dialog modal__dialog--scroll-inside modal__dialog--md"
        data-placement="auto"
        data-rac=""
        data-slot="modal-dialog"
        id="react-aria-_r_35_"
        role="dialog"
        tabindex="-1"
      >
        <h2
          class="modal__heading"
          data-slot="modal-heading"
          slot="title"
        >
          Inner
        </h2>
        <div
          class="modal__body modal__body--scroll-inside"
          data-slot="modal-body"
        >
          inner body
        </div>
      </section>
    </div>
     
  </div>
  <span
    aria-hidden="true"
    data-focus-scope-end="true"
    hidden=""
  />
  <span
    aria-hidden="true"
    data-focus-scope-start="true"
    hidden=""
  />
  <div
    aria-hidden="true"
    class="modal__backdrop modal__backdrop--opaque"
    data-rac=""
    data-slot="modal-backdrop"
    style="--visual-viewport-width: 0px; --visual-viewport-height: 0px; --page-width: 0px; --page-height: 0px;"
  >
    <div
      class="modal__container"
      data-placement="auto"
      data-rac=""
      data-slot="modal-container"
    >
      <div
        style="border: 0px; clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; width: 1px; white-space: nowrap;"
      >
        <button
          aria-label="Dismiss"
          id="react-aria-_r_32_"
          style="width: 1px; height: 1px;"
          tabindex="-1"
        />
      </div>
      <section
        aria-label="Outer"
        class="modal__dialog modal__dialog--scroll-inside modal__dialog--md"
        data-placement="auto"
        data-rac=""
        data-slot="modal-dialog"
        id="react-aria-_r_30_"
        role="dialog"
        tabindex="-1"
      >
        <h2
          class="modal__heading"
          data-slot="modal-heading"
          slot="title"
        >
          Outer
        </h2>
        <div
          class="modal__body modal__body--scroll-inside"
          data-slot="modal-body"
        />
      </section>
    </div>
     
  </div>
  <span
    aria-hidden="true"
    data-focus-scope-end="true"
    hidden=""
  />
</body>
```

Look at: `app/tests/heroui-spike.test.tsx:303`  

<sub>e2e 0.20.0 · run `01a16460-168c-76e5-9383-598469d4b5a6` · the whole run is in `report.json`</sub>
