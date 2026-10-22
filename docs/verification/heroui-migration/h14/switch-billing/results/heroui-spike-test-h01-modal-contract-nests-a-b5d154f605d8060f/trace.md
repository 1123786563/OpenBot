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
          id="react-aria5592969928-_r_2u_"
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
        id="react-aria5592969928-_r_2s_"
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
          id="react-aria5592969928-_r_2p_"
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
        id="react-aria5592969928-_r_2n_"
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
          id="react-aria5592969928-_r_2u_"
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
        id="react-aria5592969928-_r_2s_"
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
          id="react-aria5592969928-_r_2p_"
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
        id="react-aria5592969928-_r_2n_"
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

Look at: `app/tests/heroui-spike.test.tsx:305`  

<sub>e2e 0.20.0 · run `01a15839-51bc-77ff-b93b-013c4b944854` · the whole run is in `report.json`</sub>
