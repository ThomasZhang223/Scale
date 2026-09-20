#!/usr/bin/env python3
"""Emit docs/architecture/index.html — one hand-authored inline SVG, no auto-layout.

Every coordinate below is chosen by hand; this script only saves re-typing them. Nothing
here lays out a graph: the bands, the columns and the gutters are a fixed grid.
"""
from __future__ import annotations

import html
import pathlib

OUT = pathlib.Path(__file__).resolve().parents[0] / "index.html"

W = 1920

# ---------------------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------------------
BG = "#FAF7F2"
INK = "#1B1B1F"
MUTED = "#54514C"          # 7.4:1 on BG
HAIR = "#D9D3C7"
CF_FILL = "#FFF1E3"
CF_EDGE = "#F6821F"
CF_RULE = "#F6821F"
CF_DEEP = "#8A4405"        # orange dark enough for text
LAPTOP = "#EEF1F4"
VENDOR = "#F1F4EE"
DEVICE = "#F4F1EA"
WHITE = "#FFFFFF"

FLOWS = [
    # n, title, line colour, text colour, badge numeral colour
    (1, "Scan an object that is for sale nowhere", "#D1495B", "#A63347", "#FFFFFF"),
    (2, "Catalogue a live storefront", "#00798C", "#005F6E", "#FFFFFF"),
    (3, "Find something that fits the 80 cm gap", "#EDAE49", "#8A5E00", "#2B1D00"),
    (4, "Rearrange my room", "#30638E", "#2A567D", "#FFFFFF"),
]
FLOW_LINE = {n: c for n, _, c, _, _ in FLOWS}
FLOW_TEXT = {n: c for n, _, _, c, _ in FLOWS}
FLOW_NUM = {n: c for n, _, _, _, c in FLOWS}

SANS = "'Space Grotesk', 'Avenir Next', 'Segoe UI', sans-serif"
MONO = "'IBM Plex Mono', 'SFMono-Regular', Menlo, monospace"

parts: list[str] = []
def add(s: str) -> None:
    parts.append(s)

def esc(s: str) -> str:
    return html.escape(s, quote=True)

def text(x, y, s, size=13, fill=INK, weight=400, font=SANS, anchor="start", ls="0"):
    return (f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" '
            f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" '
            f'letter-spacing="{ls}">{esc(s)}</text>')

def rect(x, y, w, h, fill, stroke=None, sw=1, r=10, extra=""):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"{st}{extra}/>'

# crude but stable width estimates, used only to wrap chip rows
def wsans(s, size):
    return len(s) * size * 0.545
def wmono(s, size):
    return len(s) * size * 0.60

# ---------------------------------------------------------------------------------------
# vertical grid
# ---------------------------------------------------------------------------------------
M = 40
IW = W - 2 * M                      # 1840

HEAD_H = 108
DEV_Y, DEV_H = 118, 176             # 118 .. 294
CF_Y, CF_H = 344, 1000              # 344 .. 1344   (gutter A 294..344)
BOT_Y, BOT_H = 1394, 262            # 1394 .. 1656  (gutter B 1344..1394)
SEC_Y, SEC_H = 1684, 452            # 1684 .. 2136
TAB_Y, TAB_H = 2164, 300            # 2164 .. 2464
H = 2500

# ---------------------------------------------------------------------------------------
# defs
# ---------------------------------------------------------------------------------------
add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
    f'role="img" aria-label="Full Scale system architecture">')
add('<defs>')
for n, _, line, _, _ in FLOWS:
    add(f'<marker id="ah{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        f'markerHeight="7" orient="auto-start-reverse">'
        f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{line}"/></marker>')
add('<marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
    f'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{MUTED}"/></marker>')
add('<marker id="ahc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" '
    f'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{CF_DEEP}"/></marker>')
add('</defs>')
add(rect(0, 0, W, H, BG, r=0))

# ---------------------------------------------------------------------------------------
# header
# ---------------------------------------------------------------------------------------
add(text(M, 52, "Full Scale — system architecture", 34, INK, 700, ls="-0.6"))
add(text(M, 80, "Scan your room and any real object, then place it at true measured scale.", 15, MUTED, 500))
add(text(M, 100, "Hack the North 2026 · verified against the deployed system, 2026-09-20 06:25 UTC",
         12, MUTED, 400, font=MONO))

pills = [
    ("16", "Cloudflare products", "in use, each proved by a config line"),
    ("3", "Workers · 4 Durable Objects", "2 Workflows · 1 Queue · 1 cron"),
    ("0", "device bytes that skip Cloudflare", "no vendor key ever reaches a client"),
]
px = W - M
for num, l1, l2 in reversed(pills):
    pw = 22 + wsans(num, 28) + 12 + max(wsans(l1, 12.5), wsans(l2, 11.5)) + 20
    px -= pw
    add(rect(px, 26, pw, 62, WHITE, HAIR, 1, 12))
    add(text(px + 18, 68, num, 28, CF_DEEP, 700))
    tx = px + 18 + wsans(num, 28) + 12
    add(text(tx, 52, l1, 12.5, INK, 700))
    add(text(tx, 70, l2, 11.5, MUTED, 500))
    px -= 14

# ---------------------------------------------------------------------------------------
# helpers: node + badge
# ---------------------------------------------------------------------------------------
def badges(x, y, nums, r=11, gap=5):
    """Numbered flow badges, drawn right-to-left from x (their right edge)."""
    out = []
    cx = x - r
    for n in reversed(nums):
        out.append(f'<circle cx="{cx}" cy="{y}" r="{r}" fill="{FLOW_LINE[n]}"/>')
        out.append(f'<text x="{cx}" y="{y + 4.5}" font-family="{SANS}" font-size="13" '
                   f'font-weight="700" fill="{FLOW_NUM[n]}" text-anchor="middle">{n}</text>')
        cx -= 2 * r + gap
    return "".join(out)

def cf_node(x, y, w, h, name, resource, role, nums=(), note=None):
    """A white Cloudflare product card with the orange left rule."""
    out = [rect(x, y, w, h, WHITE, HAIR, 1, 10)]
    out.append(f'<path d="M {x + 0.5} {y + 10} a 10 10 0 0 1 10 -10 l 0 0 l 0 {h} '
               f'a 10 10 0 0 1 -10 -10 z" fill="{CF_RULE}"/>')
    out.append(f'<rect x="{x}" y="{y}" width="4" height="{h}" fill="{CF_RULE}"/>')
    out.append(text(x + 16, y + 26, name, 15.5, INK, 700))
    res_lines = resource if isinstance(resource, (list, tuple)) else [resource]
    ry_ = y + 46
    for rl in res_lines:
        out.append(text(x + 16, ry_, rl, 11.5, CF_DEEP, 500, font=MONO))
        ry_ += 15
    ty = ry_ + 6
    for line in role:
        out.append(text(x + 16, ty, line, 12.5, MUTED, 500))
        ty += 17
    if note:
        out.append(text(x + 16, y + h - 12, note, 11, CF_DEEP, 500, font=MONO))
    if nums:
        out.append(badges(x + w - 12, y + 22, nums))
    return "".join(out)

# ---------------------------------------------------------------------------------------
# devices band
# ---------------------------------------------------------------------------------------
add(rect(M, DEV_Y, IW, DEV_H, DEVICE, HAIR, 1.5, 16))
add(text(M + 24, DEV_Y + 30, "DEVICES", 13, MUTED, 700, ls="1.6"))
add(text(M + 24 + 88, DEV_Y + 30,
         "— the only two clients. Neither holds a vendor key, and neither talks to anything "
         "but Cloudflare.", 12.5, MUTED, 500))

def device_card(x, y, w, h, title, sub, chips, bullets, nums):
    out = [rect(x, y, w, h, WHITE, HAIR, 1, 10)]
    out.append(text(x + 18, y + 30, title, 17, INK, 700))
    out.append(text(x + 18, y + 50, sub, 12, MUTED, 500, font=MONO))
    by = y + 74
    for b in bullets:
        out.append(f'<circle cx="{x + 22}" cy="{by - 4}" r="2.5" fill="{MUTED}"/>')
        out.append(text(x + 32, by, b, 12.5, INK, 500))
        by += 18
    cx = x + w - 18
    for label in reversed(chips):
        cw = wsans(label, 12) + 26
        cx -= cw
        out.append(rect(cx, y + h - 40, cw, 26, BG, INK, 1.2, 13))
        out.append(text(cx + cw / 2, y + h - 22, label, 12, INK, 700, anchor="middle"))
        cx -= 8
    if nums:
        out.append(badges(x + w - 18, y + 26, nums))
    return "".join(out)

dev_w = (IW - 48 - 32) // 2
add(device_card(M + 24, DEV_Y + 42, dev_w, DEV_H - 66,
                "Expo iOS app", "apps/mobile · Expo SDK 57 · 4 Swift modules",
                ["Expo"],
                ["RoomPlan LiDAR room scan · Object Capture → GLBExporter.swift",
                 "Apple Speech on device · AR place-at-scale"],
                (1, 3)))
add(device_card(M + 24 + dev_w + 32, DEV_Y + 42, dev_w, DEV_H - 66,
                "Quest 3 — WebXR page", "apps/xr · three.js + rapier3d · 1:1 immersive-ar",
                ["WebXR"],
                ["Ships no model files. Lists and streams everything live.",
                 "Voice in, voice out; stands inside the room at true scale."],
                (3, 4)))

# ---------------------------------------------------------------------------------------
# gutter A — structural arrows + the headline claim
# ---------------------------------------------------------------------------------------
GA = (DEV_Y + DEV_H, CF_Y)
for cx in (M + 24 + dev_w * 0.42, M + 24 + dev_w + 32 + dev_w * 0.42):
    add(f'<path d="M {cx:.0f} {GA[0]} L {cx:.0f} {GA[1]}" stroke="{CF_DEEP}" stroke-width="2.5" '
        f'fill="none" marker-end="url(#ahc)" marker-start="url(#ahc)"/>')
add(text(W / 2, GA[0] + 32, "every byte, both directions — HTTPS + SSE, one origin",
         13, CF_DEEP, 700, anchor="middle"))

# ---------------------------------------------------------------------------------------
# Cloudflare band
# ---------------------------------------------------------------------------------------
add(rect(M, CF_Y, IW, CF_H, CF_FILL, CF_EDGE, 2, 16))
add(f'<rect x="{M + 24}" y="{CF_Y + 26}" width="6" height="42" rx="3" fill="{CF_EDGE}"/>')
add(text(M + 42, CF_Y + 48, "CLOUDFLARE — the only front door", 25, INK, 700, ls="-0.3"))
add(text(M + 42, CF_Y + 68,
         "State, storage, search, orchestration and both agents run here. The laptop and every "
         "vendor are tools that Cloudflare calls — never a relay, never a second origin.",
         13, CF_DEEP, 500))

IX, IW2 = M + 24, IW - 48           # 64 .. 1856

# -- the three Workers -------------------------------------------------------------------
WK_Y, WK_H = CF_Y + 92, 140
wk_w = (IW2 - 2 * 28) // 3

def worker_card(x, name, url, lines, tag, nums):
    out = [rect(x, WK_Y, wk_w, WK_H, WHITE, CF_EDGE, 2, 10)]
    out.append(text(x + 18, WK_Y + 30, name, 18, INK, 700))
    out.append(text(x + 18, WK_Y + 50, url, 11.5, CF_DEEP, 500, font=MONO))
    ty = WK_Y + 74
    for ln in lines:
        out.append(text(x + 18, ty, ln, 12.5, MUTED, 500))
        ty += 17
    tw = wsans(tag, 11.5) + 22
    out.append(rect(x + 18, WK_Y + WK_H - 34, tw, 24, CF_FILL, CF_EDGE, 1, 12))
    out.append(text(x + 18 + tw / 2, WK_Y + WK_H - 18, tag, 11.5, CF_DEEP, 700, anchor="middle"))
    out.append(badges(x + wk_w - 14, WK_Y + 26, nums))
    return "".join(out)

add(worker_card(IX, "full-scale-workers", "workers/ · the only /v1 front door",
                ["30 routes: rooms, objects, uploads, search, fit,",
                 "find, catalogue intake, jobs, SSE, R2 assets."],
                "Worker #1", (1, 2, 3)))
add(worker_card(IX + wk_w + 28, "designer-agent", "services/agent/ · Agents SDK",
                ["One Durable Object per room. Turns a sentence",
                 "into a plan with no coordinates in it."],
                "Worker #2", (4,)))
add(worker_card(IX + 2 * (wk_w + 28), "full-scale-xr", "apps/xr/ · static assets + voice",
                ["Serves the WebXR page and proxies /v1 over",
                 "service bindings. Holds the ElevenLabs key."],
                "Worker #3", (3, 4)))

# service-binding arrows between worker 3 and the other two
sb_y = WK_Y + WK_H + 30
x3 = IX + 2 * (wk_w + 28) + wk_w * 0.28
x1 = IX + wk_w * 0.72
x2 = IX + wk_w + 28 + wk_w * 0.72
add(f'<path d="M {x3:.0f} {WK_Y + WK_H} L {x3:.0f} {sb_y} L {x1:.0f} {sb_y} L {x1:.0f} {WK_Y + WK_H}" '
    f'stroke="{CF_DEEP}" stroke-width="2" fill="none" marker-end="url(#ahc)"/>')
add(f'<path d="M {x3:.0f} {sb_y} L {x2:.0f} {sb_y} L {x2:.0f} {WK_Y + WK_H}" '
    f'stroke="{CF_DEEP}" stroke-width="2" fill="none" marker-end="url(#ahc)"/>')
_sbl = "service bindings  API · AGENT"
_sbw = wmono(_sbl, 11.5) + 20
add(rect((x2 + x3) / 2 - _sbw / 2, sb_y - 22, _sbw, 22, CF_FILL, None, 0, 11))
add(text((x2 + x3) / 2, sb_y - 7, _sbl, 11.5, CF_DEEP, 700, font=MONO, anchor="middle"))
add(text(IX, sb_y + 20,
         "A Worker cannot fetch another Worker of the same account by URL — so it binds to it. "
         "The Quest therefore sees exactly one origin.", 12, MUTED, 500))

# -- the four product groups -------------------------------------------------------------
GP_Y = sb_y + 42
GP_H = CF_Y + CF_H - 28 - GP_Y
gp_w = (IW2 - 3 * 20) // 4

GROUPS = [
    ("COMPUTE", [
        ("Workers", "full-scale-workers · designer-agent · full-scale-xr",
         ["Three deployed Workers. All logic,", "all routing, all auth."], (1, 2, 3, 4), None),
        ("Durable Objects", ["RoomAgent · ScoutAgent · MeshDispatcher",
          "DesignerAgent (in Worker #2)"],
         ["Per-room memory and the SSE fan-out;", "one mesh admission slot at a time."], (2, 4), None),
        ("Workers AI", "@cf/openai/gpt-oss-120b · llama-3.2-11b-vision",
         ["The brain inside RoomAgent. Emits a", "ConstraintPlan — never a coordinate."], (4,),
         "built; the headset uses designer-agent today"),
        ("Agents SDK", "agents@0.24 — Agent, getAgentByName",
         ["Memory, tool loop and per-agent SQL,", "in four agent classes."], (2, 4), None),
    ]),
    ("DATA", [
        ("D1", "full-scale-db",
         ["rooms · versions · objects · jobs ·", "mesh_outbox. Every write is a row here."], (1, 2, 3, 4), None),
        ("R2", "full-scale-objects  (private)",
         ["GLB meshes, LiDAR frames, product", "photos. Served via GET /v1/assets/{key}."], (1, 2), None),
        ("Vectorize", "objects-v1 · 768-dim SigLIP 2 · cosine",
         ["Style by vector, fit by integer-millimetre", "filter: w_mm/h_mm/d_mm $lte."], (1, 3), None),
        ("Workers KV", "CONFIG",
         ["Tunnel origins, encoder fingerprint,", "90-second upload grants."], (1, 4), None),
    ]),
    ("ASYNC", [
        ("Workflows", "generate-mesh · ingest-merchant",
         ["Each step.do() retries on its own —", "what a flaky GPU actually needs."], (2,),
         "BASETEN_URL names the adapter, not Baseten"),
        ("Queues", "full-scale-jobs · 1 consumer · 3 retries",
         ["Delivery and back-off for every", "mesh generation job."], (2,), None),
        ("Cron Triggers", "crons = [\"* * * * *\"]",
         ["Drains the outbox once a minute.", "Nothing is lost to a crash."], (2,), None),
        ("D1 transactional outbox", "mesh_outbox",
         ["The job row and its message commit", "together, or neither commits."], (2,), None),
    ]),
    ("EDGE", [
        ("Workers Static Assets", "apps/xr/dist · run_worker_first = [\"/v1/*\"]",
         ["The WebXR page itself, on a secure", "origin the Quest already trusts."], (3, 4), None),
        ("Service Bindings", "API → full-scale-workers · AGENT → designer-agent",
         ["Worker to Worker with no public hop", "and no CORS."], (3, 4), None),
        ("Cloudflare Tunnel", "cloudflared · upstream:solver|search|ingest|embedding",
         ["The only route to the laptop. The laptop", "has no open port and no inbound DNS."], (1, 2, 3, 4), None),
        ("Browser Rendering", "[browser] binding · quickAction(\"markdown\")",
         ["Reads a storefront that serves no", "product JSON, from inside the agent."], (2,),
         "ScoutAgent tool path"),
    ]),
]

for gi, (gname, nodes) in enumerate(GROUPS):
    gx = IX + gi * (gp_w + 20)
    add(rect(gx, GP_Y, gp_w, GP_H, "#FFFAF4", CF_EDGE, 1, 12,
             extra=' stroke-dasharray="5 4" stroke-opacity="0.55"'))
    add(text(gx + 14, GP_Y + 26, gname, 12.5, CF_DEEP, 700, ls="1.8"))
    n_h = (GP_H - 44 - 3 * 10) // 4
    for ni, (name, res, role, nums, note) in enumerate(nodes):
        ny = GP_Y + 40 + ni * (n_h + 10)
        add(cf_node(gx + 12, ny, gp_w - 24, n_h, name, res, role, nums, note))

# ---------------------------------------------------------------------------------------
# gutter B — down to the laptop and the vendors
# ---------------------------------------------------------------------------------------
lap_x, lap_w = M, 920
ven_x, ven_w = M + 940, IW - 940
add(f'<path d="M {lap_x + lap_w * 0.42:.0f} {CF_Y + CF_H} L {lap_x + lap_w * 0.42:.0f} {BOT_Y}" '
    f'stroke="{CF_DEEP}" stroke-width="2.5" fill="none" marker-end="url(#ahc)" marker-start="url(#ahc)"/>')
add(f'<path d="M {ven_x + ven_w * 0.5:.0f} {CF_Y + CF_H} L {ven_x + ven_w * 0.5:.0f} {BOT_Y}" '
    f'stroke="{CF_DEEP}" stroke-width="2.5" fill="none" marker-end="url(#ahc)"/>')
add(text(lap_x + lap_w * 0.42 + 14, CF_Y + CF_H + 30,
         "Cloudflare Tunnel — outbound only", 12.5, CF_DEEP, 700))
add(text(ven_x + ven_w * 0.5 + 14, CF_Y + CF_H + 30,
         "Cloudflare calls the vendor; the device never does", 12.5, CF_DEEP, 700))

# ---------------------------------------------------------------------------------------
# bottom split — laptop edge / vendors
# ---------------------------------------------------------------------------------------
add(rect(lap_x, BOT_Y, lap_w, BOT_H, LAPTOP, HAIR, 1.5, 16))
add(text(lap_x + 22, BOT_Y + 28, "LAPTOP EDGE", 13, MUTED, 700, ls="1.6"))
add(text(lap_x + 22 + 108, BOT_Y + 28,
         "— stateless tools, no database, reached only through Cloudflare Tunnel",
         12.5, MUTED, 500))
add(f'<circle cx="{lap_x + lap_w - 216}" cy="{BOT_Y + 24}" r="5" fill="#2E7D4F"/>')
add(text(lap_x + lap_w - 204, BOT_Y + 28, "live", 11.5, MUTED, 600))
add(f'<circle cx="{lap_x + lap_w - 170}" cy="{BOT_Y + 24}" r="5" fill="{WHITE}" '
    f'stroke="{MUTED}" stroke-width="1.5"/>')
add(text(lap_x + lap_w - 158, BOT_Y + 28, "built, off the path today", 11.5, MUTED, 600))

LAP = [
    ("fit", ":8001", "OR-Tools CP-SAT — /fit and /solve", "C++ extension; Workers Python is Pyodide", (4,), True),
    ("embedding", ":8004", "SigLIP 2 — embeds queries and photos", "2 GB of pinned weights", (1, 3), True),
    ("ingest", ":8003", "Crawl, /find, dimension extraction", "long crawls, Python scraping stack", (2,), True),
    ("search", ":8005", "Standby ranker (Vectorize path is live)", "fallback only, not on the path", (), False),
    ("gen adapter", ":8006", "SF3D + the scale binding, exactly once", "live; Worker BASETEN_URL unset", (2,), False),
]
ly = BOT_Y + 48
for name, port, role, why, nums, live in LAP:
    add(rect(lap_x + 18, ly, lap_w - 36, 38, WHITE, HAIR, 1, 8))
    add(f'<circle cx="{lap_x + 34}" cy="{ly + 19}" r="5" fill="{"#2E7D4F" if live else "#FFFFFF"}" '
        f'stroke="{"#2E7D4F" if live else MUTED}" stroke-width="1.5"/>')
    add(text(lap_x + 48, ly + 24, name, 14, INK, 700, font=MONO))
    add(text(lap_x + 48 + 106, ly + 24, port, 12, MUTED, 500, font=MONO))
    add(text(lap_x + 48 + 164, ly + 24, role, 12.5, INK, 500))
    add(text(lap_x + lap_w - 88, ly + 24, why, 11.5, MUTED, 500, anchor="end"))
    if nums:
        add(badges(lap_x + lap_w - 22, ly + 19, nums, r=9, gap=4))
    ly += 42

add(rect(ven_x, BOT_Y, ven_w, BOT_H, VENDOR, HAIR, 1.5, 16))
add(text(ven_x + 22, BOT_Y + 28, "VENDORS", 13, MUTED, 700, ls="1.6"))
add(text(ven_x + 22 + 78, BOT_Y + 28,
         "— each attached to the one component that calls it", 12.5, MUTED, 500))

VEN = [
    ("Baseten", "SF3D image-to-3D · L4 · model 3mzlyd6w", "reached only via the gen adapter", (2,)),
    ("Browserbase", "Headless storefront sessions", "called by services/ingest", (2,)),
    ("Shopify storefronts", "Public /products.json + collections", "read by services/ingest", (2,)),
    ("OpenAI", "Layout planner · dimension extraction", "designer-agent + services/ingest", (2, 4)),
    ("ElevenLabs", "Headset voice: STT in, TTS out", "called by full-scale-xr", (4,)),
]
vy = BOT_Y + 48
for name, role, who, nums in VEN:
    add(rect(ven_x + 18, vy, ven_w - 36, 38, WHITE, HAIR, 1, 8))
    nw = wsans(name, 12.5) + 24
    add(rect(ven_x + 30, vy + 8, nw, 22, BG, INK, 1.2, 11))
    add(text(ven_x + 30 + nw / 2, vy + 23, name, 12.5, INK, 700, anchor="middle"))
    add(text(ven_x + 30 + nw + 16, vy + 24, role, 12.5, INK, 500))
    add(text(ven_x + ven_w - 88, vy + 24, who, 11.5, MUTED, 500, anchor="end", font=MONO))
    add(badges(ven_x + ven_w - 22, vy + 19, nums, r=9, gap=4))
    vy += 42

# ---------------------------------------------------------------------------------------
# section: flows (left) + product checklist (right)
# ---------------------------------------------------------------------------------------
fl_x, fl_w = M, 1124
ck_x, ck_w = M + 1144, IW - 1144

add(rect(fl_x, SEC_Y, fl_w, SEC_H, WHITE, HAIR, 1.5, 16))
add(text(fl_x + 22, SEC_Y + 30, "THE FOUR FLOWS", 13, MUTED, 700, ls="1.6"))
add(text(fl_x + 22 + 132, SEC_Y + 30,
         "— the numbered badges above mark every component each one touches",
         12.5, MUTED, 500))

CHAINS = [
    (1, [("mono", "Object Capture"), ("mono", "GLBExporter.swift"), ("mono", "POST /v1/objects"),
         ("mono", "POST /v1/uploads"), ("cf", "Worker streams the PUT"), ("cf", "R2 scans/{id}/mesh.glb"),
         ("lap", "SigLIP 2 over Tunnel"), ("cf", "Vectorize objects-v1")]),
    (2, [("ven", "Shopify /products.json"), ("ven", "Browserbase renders the page"),
         ("lap", "ingest /crawl + /extract"), ("mono", "POST /v1/catalog/ingest"),
         ("cf", "D1 objects + mesh_outbox"), ("cf", "cron every 60 s"), ("cf", "Queue"),
         ("cf", "MeshDispatcher"), ("cf", "GenerateMeshWorkflow"), ("lap", "gen adapter binds the scale"),
         ("ven", "Baseten SF3D"),
         ("cf", "R2 objects/{id}/mesh.glb")]),
    (3, [("mono", "POST /v1/search"), ("lap", "SigLIP 2 embeds the sentence"),
         ("cf", "Vectorize: cosine style"), ("cf", "+ w_mm/h_mm/d_mm $lte fit filter"),
         ("cf", "D1 hydrates the rows"), ("mono", "phone or headset")]),
    (4, [("mono", "a sentence in the Quest"), ("ven", "ElevenLabs STT"),
         ("cf", "designer-agent Durable Object"), ("cf", "plan, never coordinates"),
         ("lap", "OR-Tools CP-SAT over Tunnel"), ("cf", "new Version in D1"),
         ("cf", "RoomAgent SSE"), ("mono", "both devices update")]),
]
CHIP = {"cf": (CF_FILL, CF_EDGE, INK), "lap": (LAPTOP, "#9FAEBC", INK),
        "ven": (VENDOR, "#A7BC9F", INK), "mono": (BG, HAIR, INK)}

fy = SEC_Y + 50
for n, chain in CHAINS:
    title = [t for num, t, *_ in FLOWS if num == n][0]
    add(f'<circle cx="{fl_x + 34}" cy="{fy + 10}" r="13" fill="{FLOW_LINE[n]}"/>')
    add(f'<text x="{fl_x + 34}" y="{fy + 15}" font-family="{SANS}" font-size="15" '
        f'font-weight="700" fill="{FLOW_NUM[n]}" text-anchor="middle">{n}</text>')
    add(text(fl_x + 56, fy + 15, title, 15, FLOW_TEXT[n], 700))
    # chips, greedily wrapped to two lines
    max_w = fl_w - 72
    lines, cur, cur_w = [], [], 0.0
    for kind, label in chain:
        cw = wsans(label, 11.5) + 22
        if cur and cur_w + cw + 18 > max_w:
            lines.append(cur); cur, cur_w = [], 0.0
        cur.append((kind, label, cw)); cur_w += cw + 18
    if cur:
        lines.append(cur)
    cy = fy + 32
    for li, line in enumerate(lines):
        cx = fl_x + 56
        for ci, (kind, label, cw) in enumerate(line):
            fill, stroke, tc = CHIP[kind]
            add(rect(cx, cy, cw, 24, fill, stroke, 1, 12))
            add(text(cx + cw / 2, cy + 16, label, 11.5, tc, 600, anchor="middle"))
            cx += cw
            last = (ci == len(line) - 1)
            if not last or li < len(lines) - 1:
                add(f'<path d="M {cx + 3} {cy + 12} L {cx + 13} {cy + 12}" stroke="{FLOW_LINE[n]}" '
                    f'stroke-width="2" marker-end="url(#ah{n})"/>')
            cx += 18
        cy += 30
    fy = cy + 12

# checklist
add(rect(ck_x, SEC_Y, ck_w, SEC_H, WHITE, CF_EDGE, 1.5, 16))
add(text(ck_x + 22, SEC_Y + 32, "Cloudflare products in use: 16", 17, INK, 700))
add(text(ck_x + 22, SEC_Y + 52, "every line below is proved by a config line in this repo",
         11.5, CF_DEEP, 500, font=MONO))

CHECK = [
    ("Workers", "3 × wrangler.toml"),
    ("Durable Objects", "new_sqlite_classes × 4"),
    ("Workflows", "[[workflows]] × 2"),
    ("Queues", "producers + consumers"),
    ("Cron Triggers", "crons = [\"* * * * *\"]"),
    ("Workers AI", "[ai] binding = \"AI\""),
    ("Agents SDK", "agents ^0.24.0"),
    ("Browser Rendering", "[browser] binding"),
    ("D1", "full-scale-db"),
    ("R2", "full-scale-objects"),
    ("Workers KV", "CONFIG"),
    ("Vectorize", "objects-v1, 768-dim"),
    ("Static Assets", "[assets] apps/xr/dist"),
    ("Service Bindings", "[[services]] API, AGENT"),
    ("Cloudflare Tunnel", "infra/up.sh cloudflared"),
    ("Workers Observability", "[observability] × 3"),
]
col_w = (ck_w - 44) / 2
for i, (name, proof) in enumerate(CHECK):
    col, row = i // 8, i % 8
    cx = ck_x + 22 + col * col_w
    cy = SEC_Y + 78 + row * 45
    add(f'<path d="M {cx + 2} {cy + 12} l 5 6 l 10 -13" stroke="{CF_EDGE}" stroke-width="2.6" '
        f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    add(text(cx + 26, cy + 16, name, 13.5, INK, 700))
    add(text(cx + 26, cy + 33, proof, 11.5, CF_DEEP, 500, font=MONO))

# ---------------------------------------------------------------------------------------
# sponsor table
# ---------------------------------------------------------------------------------------
add(rect(M, TAB_Y, IW, TAB_H, WHITE, HAIR, 1.5, 16))
add(text(M + 22, TAB_Y + 32, "Sponsor → where it is in the repo → what it does for the product",
         17, INK, 700))
add(text(M + 22, TAB_Y + 52,
         "Nothing is listed that the code does not call. Sponsors whose technology this project "
         "does not use are deliberately absent.", 12, MUTED, 500))

COLS = [(M + 22, 260), (M + 292, 470), (M + 782, 1078)]
hy = TAB_Y + 82
for (cx, _), label in zip(COLS, ["SPONSOR", "WHERE IN THE REPO", "WHAT IT DOES"]):
    add(text(cx, hy, label, 11.5, MUTED, 700, ls="1.4"))
add(f'<path d="M {M + 22} {hy + 10} L {W - M - 22} {hy + 10}" stroke="{HAIR}" stroke-width="1.5"/>')

ROWS = [
    ("Cloudflare", "workers/ · apps/xr/ · services/agent/ — 3 wrangler.toml",
     "16 products: the entire runtime, state, storage, search, orchestration and both agents"),
    ("Expo", "apps/mobile/app.json — SDK 57, 3 config plugins",
     "The iOS app and 4 Swift modules: RoomPlan, Object Capture, depth measure, Speech"),
    ("Shopify", "services/ingest/verify_merchants.py · build_prebake.py",
     "Public /products.json and /collections/<handle>/products.json are the catalogue source"),
    ("Browserbase", "services/ingest/app/browserbase.py · page_extract.py",
     "Renders the product pages whose dimensions live in metafields that JSON never serves"),
    ("Baseten", "services/gen/app/generate_server.py · Dockerfile.adapter",
     "SF3D image-to-3D on an L4, behind the adapter that binds metric scale exactly once"),
    ("OpenAI", "services/agent/src/agent.ts · services/ingest/app/ai_extract.py",
     "The layout planner in designer-agent, and the LLM/VLM dimension passes in extraction"),
    ("ElevenLabs", "apps/xr/worker/index.ts — /v1/voice/stt and /v1/voice/tts",
     "Headset speech in and speech out; the API key never leaves the Worker"),
]
ry = hy + 34
for name, where, what in ROWS:
    nw = wsans(name, 12.5) + 26
    add(rect(COLS[0][0], ry - 15, nw, 23, BG, INK, 1.2, 11))
    add(text(COLS[0][0] + nw / 2, ry, name, 12.5, INK, 700, anchor="middle"))
    add(text(COLS[1][0], ry, where, 11.5, CF_DEEP if name == "Cloudflare" else MUTED, 500, font=MONO))
    add(text(COLS[2][0], ry, what, 12.5, INK, 500))
    ry += 29

add('</svg>')

svg = "\n".join(parts)

HTML = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Full Scale Architecture</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {{ color-scheme: light; }}
  html, body {{ margin: 0; padding: 0; background: {BG}; }}
  body {{ font-family: {SANS}; }}
  .wrap {{ max-width: 1920px; margin: 0 auto; padding: 0; }}
  svg {{ display: block; width: 100%; height: auto; }}
</style>
</head>
<body>
<div class="wrap">
{svg}
</div>
</body>
</html>
"""

OUT.write_text(HTML, encoding="utf-8")
print(f"wrote {OUT}  ({len(HTML)} bytes)  canvas {W}x{H}")
