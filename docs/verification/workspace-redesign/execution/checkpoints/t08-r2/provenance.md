# T08-R2 checkpoint provenance

The R2 worker and brief captured PRE SHA-256 values immediately before edits but did not initially retain a dedicated directory. These PRE bytes are reconstructed from authoritative preserved sources and independently hash-matched: Item from `git show HEAD:app/tests/item-disabled.test.tsx`; DetailPanel from `checkpoints/t03-r3/POST/files/app/tests/detail-panel.test.tsx`. The POST bytes are captured from the live files after implementation and match the implementation report. HEAD was unchanged at `203d0f0244b2f898218fa12027089c631e8448d9`.
