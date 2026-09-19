"""The token gate for this service. See infra/README.md for the tunnel model this defends.

A quick-tunnel URL is unguessable but fully public, so this header is the only thing between
the open internet and the solver. It refuses to start when UPSTREAM_TOKEN is unset — an auth
check that silently passes when unconfigured is worse than no auth at all.
"""

import os

from fastapi import Header, HTTPException

_TOKEN = os.environ.get("UPSTREAM_TOKEN")
if not _TOKEN:
    raise RuntimeError("UPSTREAM_TOKEN is unset — refusing to start. See infra/README.md.")


async def require_upstream_token(x_upstream_token: str = Header(default="")) -> None:
    if x_upstream_token != _TOKEN:
        raise HTTPException(status_code=401, detail="bad or missing X-Upstream-Token")
