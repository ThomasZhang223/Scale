# embedding

`google/siglip2-base-patch16-224` embeddings (768-dim, cosine metric), written into the
`objects-v1` Vectorize index alongside a caption and a colour palette for catalog products and
saved possessions when an object's `state` flips to `"ready"`.

A scan frame used for retrieval becomes a normalized query embedding and does not need to be
inserted into the database first. Not implemented — see `.claude/contracts.md` for the Vectorize
index shape.
