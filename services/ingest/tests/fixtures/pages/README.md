# Real product pages, kept as fixtures

Three pages fetched from floydhome.com on 2026-09-19. They were in `.page-cache/` until that
directory was gitignored — a full crawl caches ~250 MB, which git has no business holding.

These three stay because they are the only real merchant markup in the repo, and they settled a
question that guesswork could not:

| Fixture | What it proves |
| --- | --- |
| `floyd-dims-headboard-add-on-cherry.html` | `page_text` recovers `67" W 18" H 1.5" D` when JSON-LD and the spec block both give nothing |
| `floyd-dims-bed-frame-expansion-kit-cherry.html` | Axis mapping on `22" W 86" D 1.5" H` — L/D is depth, not height |
| `floyd-nodims-linen-duvet-cover.html` | A page whose only numbers are GTM ids, prices and variant ids must yield **nothing** |

All three also carry Floyd's Product JSON-LD, which fails a strict parse on an invalid control
character and, once parsed, holds no dimensions at all — only `size: ["King"]`, a size name.
That is why `_loads_tolerant` tries `strict=False`, and why the structured path is dead weight
for this merchant.

`tests/test_real_pages.py` runs against them. Everything else in the page-extraction suite uses
HTML written by hand, which only proves the parser matches itself.
