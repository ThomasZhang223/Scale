# Frozen catalogue fixtures

Real `/products.json` products, pinned so `tests/test_real_catalogues.py` measures the
extractor and not the weather.

These were copied out of `../../samples/`, which is **not** a safe place for them:
`verify_merchants.py --dump` overwrites that directory on every run, and `dump_samples` takes
the first 8 products a store happens to serve. A re-run on 2026-09-20 pulled an InStyle sample
that opened with rugs and fabric codes instead of the Gia furniture line, and its usable count
went 7 -> 2. Nothing about the extractor had changed. The test correctly failed, but it was
reporting a fixture swap as a regression, which is the kind of false alarm that teaches people
to ignore a red suite.

So: `samples/` is the diagnostic dump, free to churn. This directory is the baseline, and it
changes only when someone means it to. Same split as `../pages/`, which holds three real Floyd
product pages promoted out of the gitignored `.page-cache/` for exactly this reason.

`InStyle_Home__CA_.json` is the pre-2026-09-20 sample kept on purpose: seven of its eight
products carry usable dimensions, so it exercises far more of `dimensions.py` than the
two-usable sample that replaced it. Both are real; this one tests more.

To refresh a fixture deliberately: copy it from `samples/` and update `EXPECTED` in the test
in the same commit, so the new floor is a decision someone made rather than a number that
drifted.
