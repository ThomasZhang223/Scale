#!/usr/bin/env python3
"""Emit docs/architecture/index.html — a wiring diagram, hand-authored inline SVG.

The poster is one SVG of fixed hand-placed coordinates: nodes are an icon plus a one or two
word name, wires are orthogonal, and nothing on it is a sentence. Everything a judge might
want to check in prose lives in the HTML below the poster, which the PNG never sees.
"""
from __future__ import annotations

import html
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "index.html"

W, H = 1920, 1640

BG = "#FAF7F2"
INK = "#1B1B1F"
MUTED = "#54514C"
HAIR = "#D9D3C7"
CF_FILL = "#FFF1E3"
CF_EDGE = "#F6821F"
CF_DEEP = "#8A4405"
LAPTOP = "#EEF1F4"
LAP_EDGE = "#94A5B4"
VENDOR = "#F1F4EE"
VEN_EDGE = "#8FAA82"
DEVICE = "#F4F1EA"
WHITE = "#FFFFFF"

F1, F2, F3, F4 = "#D1495B", "#00798C", "#EDAE49", "#30638E"
F3T = "#8A5E00"                      # amber is a fill colour, never a text colour

SANS = "'Space Grotesk', 'Avenir Next', 'Segoe UI', sans-serif"
MONO = "'IBM Plex Mono', 'SFMono-Regular', Menlo, monospace"

P: list[str] = []
add = P.append
esc = lambda s: html.escape(str(s), quote=True)


def txt(x, y, s, size=13, fill=INK, weight=600, font=SANS, anchor="middle", ls="0"):
    return (f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" font-weight="{weight}"'
            f' fill="{fill}" text-anchor="{anchor}" letter-spacing="{ls}">{esc(s)}</text>')


def box(x, y, w, h, fill, stroke=None, sw=1.5, r=14, dash=None):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    dd = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"{st}{dd}/>'


# =======================================================================================
# icons — every one draws inside a 40x40 box, 2px stroke, rounded joins, one line style
# =======================================================================================
def _g(cx, cy, body, colour, scale=1.0):
    return (f'<g transform="translate({cx - 20 * scale} {cy - 20 * scale}) scale({scale})" '
            f'fill="none" stroke="{colour}" stroke-width="2" stroke-linecap="round" '
            f'stroke-linejoin="round">{body}</g>')


ICONS = {
 "phone":    '<rect x="11" y="4" width="18" height="32" rx="3"/><path d="M17 32h6"/><path d="M16 9h8"/>',
 "headset":  '<rect x="4" y="13" width="32" height="15" rx="6"/><circle cx="13" cy="20.5" r="3.4"/>'
             '<circle cx="27" cy="20.5" r="3.4"/><path d="M17 28l3 3 3-3"/>',
 "worker":   '<path d="M20 4l13 7.5v17L20 36 7 28.5v-17z"/><path d="M21.5 12.5l-5.5 9h4.5l-1.5 6 5.5-9h-4.5z"/>',
 "do":       '<path d="M20 5l14 7v16l-14 7-14-7V12z"/><path d="M6 12l14 7 14-7"/><path d="M20 19v16"/>'
             '<circle cx="20" cy="19" r="2.4" fill="currentColor"/>',
 "bot":      '<rect x="9" y="13" width="22" height="18" rx="5"/><path d="M20 13V7"/><circle cx="20" cy="5.5" r="2"/>'
             '<path d="M15.5 21.5v2M24.5 21.5v2"/>',
 "chip":     '<rect x="11" y="11" width="18" height="18" rx="3"/><path d="M15 11V6M20 11V6M25 11V6'
             'M15 29v5M20 29v5M25 29v5M11 15H6M11 20H6M11 25H6M29 15h5M29 20h5M29 25h5"/>'
             '<path d="M20 15l1.6 3.4 3.4 1.6-3.4 1.6L20 25l-1.6-3.4-3.4-1.6 3.4-1.6z"/>',
 "workflow": '<rect x="4" y="6" width="12" height="9" rx="2.5"/><rect x="14" y="16" width="12" height="9" rx="2.5"/>'
             '<rect x="24" y="26" width="12" height="9" rx="2.5"/><path d="M10 15v4.5h4M20 25v4.5h4"/>',
 "queue":    '<path d="M12 7h16"/><path d="M9 11h22"/><rect x="6" y="15" width="28" height="18" rx="2.5"/>'
             '<path d="M6 17.5l14 9 14-9"/>',
 "clock":    '<circle cx="20" cy="20" r="14"/><path d="M20 11v9.5l6.5 4"/>',
 "db":       '<ellipse cx="20" cy="10" rx="12" ry="4.6"/><path d="M8 10v20a12 4.6 0 0 0 24 0V10"/>'
             '<path d="M8 20a12 4.6 0 0 0 24 0"/>',
 "bucket":   '<ellipse cx="20" cy="12" rx="13" ry="4.4"/><path d="M7 12l2.6 20.2a2 2 0 0 0 2 1.8h16.8'
             'a2 2 0 0 0 2-1.8L33 12"/><path d="M9.6 23a13 4 0 0 0 20.8 0"/>',
 "vector":   '<circle cx="20" cy="20" r="3" fill="currentColor"/><circle cx="8" cy="11" r="2.4"/>'
             '<circle cx="32" cy="13" r="2.4"/><circle cx="11" cy="32" r="2.4"/><circle cx="31" cy="30" r="2.4"/>'
             '<circle cx="21" cy="5" r="2.4"/><path d="M20 20l-9.6-7.2M20 20l11.2-6M20 20l-8 10.4M20 20l10.2 8.4"/>',
 "key":      '<circle cx="13" cy="20" r="7.5"/><path d="M20.5 20H36"/><path d="M30 20v5.5M35 20v4.5"/>',
 "file":     '<path d="M11 5h12l8 8v22a1.5 1.5 0 0 1-1.5 1.5h-18A1.5 1.5 0 0 1 10 35V6.5A1.5 1.5 0 0 1 11.5 5z"/>'
             '<path d="M23 5v8h8"/>',
 "window":   '<rect x="4" y="8" width="32" height="25" rx="3"/><path d="M4 16h32"/>'
             '<circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="14" cy="12" r="1.4" fill="currentColor"/>'
             '<circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
 "tunnel":   '<path d="M4 33h32"/><path d="M8 33V21a12 12 0 0 1 24 0v12"/><path d="M15 33V21a5 5 0 0 1 10 0v12"/>'
             '<path d="M20 26v-4"/>',
 "container":'<rect x="5" y="17" width="30" height="16" rx="2.5"/><rect x="9" y="9" width="7" height="7" rx="1.5"/>'
             '<rect x="18" y="9" width="7" height="7" rx="1.5"/><rect x="27" y="9" width="7" height="7" rx="1.5"/>',
 "solver":   '<rect x="5" y="5" width="30" height="30" rx="3"/><path d="M15 5v30M25 5v30M5 15h30M5 25h30"/>'
             '<rect x="15" y="15" width="10" height="10" fill="currentColor" stroke="none"/>',
 "funnel":   '<path d="M5 7h30L23 22v11l-6-4V22z"/>',
 "mesh":     '<path d="M20 5l13 6.6v14L20 32 7 25.6v-14z"/><path d="M7 11.6l13 6.6 13-6.6M20 18.2V32"/>'
             '<path d="M12 36h16"/><path d="M14 34l-2 2 2 2M26 34l2 2-2 2"/>',
 "gpu":      '<rect x="4" y="12" width="32" height="17" rx="2.5"/><rect x="8" y="16" width="11" height="9" rx="1.5"/>'
             '<circle cx="28" cy="20.5" r="4.4"/><path d="M12 29v5M24 29v5"/>',
 "bag":      '<path d="M9 13h22l2.4 21H6.6z"/><path d="M15 13v-2.5a5 5 0 0 1 10 0V13"/>',
 "mic":      '<rect x="15" y="5" width="10" height="17" rx="5"/><path d="M10 19a10 10 0 0 0 20 0"/>'
             '<path d="M20 29v6M14 35h12"/>',
 "spark":    '<path d="M20 4l3.2 12.8L36 20l-12.8 3.2L20 36l-3.2-12.8L4 20l12.8-3.2z"/>'
             '<path d="M32 5l1.2 4.3L37.5 10l-4.3 1.2L32 15l-1.2-3.8L26.5 10l4.3-.7z"/>',
 "ruler":    '<rect x="4" y="13" width="32" height="14" rx="2.5"/><path d="M11 13v6M17 13v6M23 13v6M29 13v6"/>',
 "plan":     '<rect x="7" y="5" width="26" height="30" rx="3"/><path d="M13 14h14M13 21h14M13 28h8"/>',
 "sse":      '<circle cx="14" cy="20" r="3" fill="currentColor"/><path d="M21 13a10 10 0 0 1 0 14"/>'
             '<path d="M26 8a17 17 0 0 1 0 24"/><path d="M31 3.5a24 24 0 0 1 0 33"/>',
}


def icon(name, cx, cy, colour=INK, scale=1.0):
    body = ICONS[name].replace("currentColor", colour)
    return _g(cx, cy, body, colour, scale)


def both_icon(cx, cy, colour=INK):
    return (icon("phone", cx - 10, cy, colour, 0.62) + icon("headset", cx + 11, cy, colour, 0.62))


# =======================================================================================
# nodes
# =======================================================================================
def node(x, y, w, h, ico, label, fill=WHITE, stroke=HAIR, ink=INK, mono=None, pill=None,
         sw=1.5, icon_colour=None):
    out = [box(x, y, w, h, fill, stroke, sw, 12)]
    cx = x + w / 2
    ic = icon_colour or ink
    top = y + (26 if mono or pill else 30)
    out.append(icon(ico, cx, top + 8, ic, 1.0))
    out.append(txt(cx, top + 42, label, 16, ink, 700))
    if mono:
        out.append(txt(cx, top + 60, mono, 11.5, CF_DEEP, 500, font=MONO))
    if pill:
        pw = len(pill) * 7.4 + 20
        out.append(box(cx - pw / 2, y + h - 26, pw, 20, BG, ink, 1.2, 10))
        out.append(txt(cx, y + h - 12, pill, 11.5, ink, 700))
    return "".join(out)


def wire(d, colour=MUTED, sw=2.4, head=True, dash=None, marker="end"):
    m = ""
    if head:
        mid = "arrow-" + colour.lstrip("#")
        m = f' marker-{marker}="url(#{mid})"'
    dd = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{sw}"{m}{dd}/>'


def dot(x, y, colour=CF_EDGE, r=4.5):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{colour}"/>'


def wlabel(x, y, s, colour):
    w = len(s) * 7.6 + 16
    return (box(x - w / 2, y - 11, w, 21, BG, None, 0, 10) +
            txt(x, y + 4, s, 12, colour, 700, font=MONO))


# =======================================================================================
# defs
# =======================================================================================
add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
    f'role="img" aria-label="Full Scale architecture wiring diagram">')
add("<defs>")
for c in {MUTED, CF_EDGE, CF_DEEP, F1, F2, F3, F4, INK}:
    add(f'<marker id="arrow-{c.lstrip("#")}" viewBox="0 0 10 10" refX="8.5" refY="5" '
        f'markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">'
        f'<path d="M0 0L10 5L0 10z" fill="{c}"/></marker>')
add("</defs>")
add(box(0, 0, W, H, BG, r=0))

# =======================================================================================
# title
# =======================================================================================
add(txt(60, 56, "Full Scale — system architecture", 36, INK, 700, anchor="start", ls="-0.6"))

# =======================================================================================
# geometry
# =======================================================================================
LX, LW = 60, 1380                       # left column
VX, VW = 1490, 370                      # vendor column
DEV_Y, DEV_H = 86, 152
CF_Y, CF_H = 276, 580
LAP_Y, LAP_H = 886, 150

WK_Y, WK_H = 350, 90                    # worker row
RAIL = 470                              # service-binding rail
BUSA = 505
T2_Y, T2_H = 545, 110                   # compute / async tier
BUSB = 685
T3_Y, T3_H = 715, 110                   # data / edge tier

FD_X, FD_W = 130, 300                   # front-door worker
XR_X, XR_W = 1070, 300                  # xr worker
FD_C, XR_C = FD_X + FD_W / 2, XR_X + XR_W / 2
DROP = 160                              # the front door's bus drop, left of every tier node

AG_X, AG_W = 1150, 200                  # designer-agent, in the compute tier
AG_C = AG_X + AG_W / 2

# =======================================================================================
# devices
# =======================================================================================
add(box(LX, DEV_Y, LW, DEV_H, DEVICE, HAIR, 1.5, 16))
add(txt(LX + 22, DEV_Y + 26, "Devices", 15, MUTED, 700, anchor="start", ls="1.2"))
add(node(FD_X, DEV_Y + 36, FD_W, DEV_H - 48, "phone", "iPhone", pill="Expo"))
add(node(XR_X, DEV_Y + 36, XR_W, DEV_H - 48, "headset", "Quest 3", pill="WebXR"))

# =======================================================================================
# Cloudflare
# =======================================================================================
add(box(LX, CF_Y, LW, CF_H, CF_FILL, CF_EDGE, 2.5, 16))
add(f'<rect x="{LX + 22}" y="{CF_Y + 20}" width="7" height="40" rx="3.5" fill="{CF_EDGE}"/>')
add(txt(LX + 42, CF_Y + 52, "Cloudflare", 30, INK, 700, anchor="start", ls="-0.3"))
add(box(940, CF_Y + 14, 204, 54, WHITE, CF_EDGE, 2, 14))
add(txt(958, CF_Y + 55, "16", 42, CF_EDGE, 700, anchor="start"))
add(txt(1012, CF_Y + 38, "Cloudflare", 15, INK, 700, anchor="start"))
add(txt(1012, CF_Y + 58, "products", 15, INK, 700, anchor="start"))

add(node(FD_X, WK_Y, FD_W, WK_H, "worker", "Worker", CF_FILL, CF_EDGE, INK,
         mono="front-door", sw=2.5))
add(node(XR_X, WK_Y, XR_W, WK_H, "worker", "Worker", CF_FILL, CF_EDGE, INK,
         mono="xr", sw=2.5))

T2 = [("do", "Durable Objects", None), ("bot", "Agents SDK", None), ("chip", "Workers AI", None),
      ("workflow", "Workflows", None), ("queue", "Queues", None), ("clock", "Cron", None)]
T3 = [("db", "D1", None), ("bucket", "R2", None), ("vector", "Vectorize", None),
      ("key", "KV", None), ("file", "Assets", None), ("window", "Browser", None),
      ("tunnel", "Tunnel", None)]

NW, NG = 130, 18
T2X = [230 + i * (NW + NG) for i in range(len(T2))]
T3X = [230 + i * (NW + NG) for i in range(len(T3))]

for (ic, lb, mn), x in zip(T2, T2X):
    add(node(x, T2_Y, NW, T2_H, ic, lb, WHITE, HAIR, INK, mono=mn, icon_colour=CF_DEEP))
add(node(AG_X, T2_Y, AG_W, T2_H, "worker", "Worker", CF_FILL, CF_EDGE, INK,
         mono="agent", sw=2.5))
for (ic, lb, mn), x in zip(T3, T3X):
    add(node(x, T3_Y, NW, T3_H, ic, lb, WHITE, HAIR, INK, mono=mn, icon_colour=CF_DEEP))

TUN_C = T3X[-1] + NW / 2

# ---- wires inside and into Cloudflare -------------------------------------------------
add(wire(f"M{FD_C} {DEV_Y + DEV_H - 12} L{FD_C} {WK_Y}", F1, 3))
add(wlabel(FD_C + 40, 258, "GLB", F1))
add(wire(f"M{XR_C} {DEV_Y + DEV_H - 12} L{XR_C} {WK_Y}", F4, 3))
add(wlabel(XR_C + 44, 258, "voice", F4))

# xr binds to the front door and to the agent
add(wire(f"M{XR_X + 90} {WK_Y + WK_H} L{XR_X + 90} {RAIL} L{FD_C} {RAIL} L{FD_C} {WK_Y + WK_H}",
         CF_DEEP, 2.4))
add(wlabel(700, RAIL, "bind", CF_DEEP))
add(wire(f"M{AG_C} {WK_Y + WK_H} L{AG_C} {T2_Y}", CF_DEEP, 2.4))

# the front door owns every binding: one drop, two buses, one stub per product
add(wire(f"M{DROP} {WK_Y + WK_H} L{DROP} {BUSB}", CF_EDGE, 2.8, head=False))
add(wire(f"M{DROP} {BUSA} L{T2X[-1] + NW} {BUSA}", CF_EDGE, 2.8, head=False))
add(wire(f"M{DROP} {BUSB} L{T3X[-1] + NW} {BUSB}", CF_EDGE, 2.8, head=False))
add(dot(DROP, BUSA))
add(dot(DROP, BUSB))
for x in T2X:
    add(wire(f"M{x + NW / 2} {BUSA} L{x + NW / 2} {T2_Y}", CF_EDGE, 2.2))
    add(dot(x + NW / 2, BUSA, CF_EDGE, 3.4))
for x in T3X:
    add(wire(f"M{x + NW / 2} {BUSB} L{x + NW / 2} {T3_Y}", CF_EDGE, 2.2))
    add(dot(x + NW / 2, BUSB, CF_EDGE, 3.4))

# =======================================================================================
# laptop
# =======================================================================================
add(box(LX, LAP_Y, LW, LAP_H, LAPTOP, LAP_EDGE, 1.5, 16))
add(txt(LX + 22, LAP_Y + 26, "Laptop", 15, MUTED, 700, anchor="start", ls="1.2"))

LAP = [("solver", "fit", 180), ("vector", "SigLIP 2", 480), ("mesh", "gen", 800),
       ("funnel", "ingest", 1120)]
LN_W, LN_H = 150, 108
for ic, lb, x in LAP:
    add(node(x, LAP_Y + 38, LN_W, LN_H, ic, lb, WHITE, HAIR, INK, icon_colour=MUTED))
LC = {lb: x + LN_W / 2 for _, lb, x in LAP}

RAIL_L = LAP_Y - 18
add(wire(f"M{TUN_C} {T3_Y + T3_H} L{TUN_C} {RAIL_L}", CF_EDGE, 2.8, head=False))
add(wire(f"M{LC['fit']} {RAIL_L} L{LC['ingest']} {RAIL_L}", CF_EDGE, 2.8, head=False))
add(dot(TUN_C, RAIL_L))
for lb in ("fit", "SigLIP 2", "gen", "ingest"):
    add(wire(f"M{LC[lb]} {RAIL_L} L{LC[lb]} {LAP_Y + 38}", CF_EDGE, 2.2))
    add(dot(LC[lb], RAIL_L, CF_EDGE, 3.4))
add(wlabel(700, RAIL_L, "tools", CF_DEEP))

# =======================================================================================
# vendors
# =======================================================================================
add(box(VX, DEV_Y, VW, 1034, VENDOR, VEN_EDGE, 1.5, 16))
add(txt(VX + 22, DEV_Y + 26, "Vendors", 15, MUTED, 700, anchor="start", ls="1.2"))

VEN = [("mic", "ElevenLabs", 357), ("spark", "OpenAI", 562), ("bag", "Shopify", 860),
       ("window", "Browserbase", 946), ("gpu", "Baseten", 1032)]
VN_W, VN_H = 300, 76
for ic, lb, y in VEN:
    add(box(VX + 35, y, VN_W, VN_H, WHITE, HAIR, 1.5, 12))
    add(icon(ic, VX + 35 + 44, y + VN_H / 2, MUTED, 1.0))
    add(txt(VX + 35 + 82, y + VN_H / 2 + 6, lb, 18, INK, 700, anchor="start"))
VC = {lb: y + VN_H / 2 for _, lb, y in VEN}

add(wire(f"M{XR_X + XR_W} {VC['ElevenLabs']} L{VX + 35} {VC['ElevenLabs']}", F4, 2.4))
add(wire(f"M{AG_X + AG_W} {VC['OpenAI']} L{VX + 35} {VC['OpenAI']}", F4, 2.4))
add(wire(f"M{VX + 35} {VC['Shopify']} L{1420} {VC['Shopify']} L{1420} {LAP_Y + 50} "
         f"L{LC['ingest'] + LN_W / 2} {LAP_Y + 50}", F2, 2.4))
add(wire(f"M{VX + 35} {VC['Browserbase']} L{1450} {VC['Browserbase']} L{1450} {LAP_Y + 96} "
         f"L{LC['ingest'] + LN_W / 2} {LAP_Y + 96}", F2, 2.4))
add(wire(f"M{LC['gen']} {LAP_Y + 146} L{LC['gen']} {LAP_Y + 168} L{1400} {LAP_Y + 168} "
         f"L{1400} {VC['Baseten']} L{VX + 35} {VC['Baseten']}", F2, 2.4))

# =======================================================================================
# pipelines — four swimlanes, icons only
# =======================================================================================
PIPE_Y = 1160
LANE_H, LANE_G = 100, 8
CFS, LAPS, VENS, DEVS = (CF_FILL, CF_EDGE), (LAPTOP, LAP_EDGE), (VENDOR, VEN_EDGE), (WHITE, HAIR)

LANES = [
    ("Scan an object", F1, [
        ("phone", "Scan", DEVS), ("worker", "Worker", CFS), ("bucket", "R2", CFS),
        ("vector", "SigLIP 2", LAPS), ("vector", "Vectorize", CFS)]),
    ("Catalogue a store", F2, [
        ("bag", "Shopify", VENS), ("window", "Browserbase", VENS), ("funnel", "ingest", LAPS),
        ("db", "D1", CFS), ("workflow", "Workflow", CFS), ("gpu", "Baseten", VENS),
        ("bucket", "R2", CFS)]),
    ("Find what fits", F3, [
        ("mic", "Voice", DEVS), ("worker", "Worker", CFS), ("vector", "Vectorize", CFS),
        ("ruler", "mm filter", CFS), ("headset", "Results", DEVS)]),
    ("Rearrange room", F4, [
        ("mic", "Voice", DEVS), ("bot", "Agent", CFS), ("plan", "Plan", CFS),
        ("solver", "OR-Tools", LAPS), ("db", "Version", CFS), ("sse", "SSE", CFS),
        ("both", "Devices", DEVS)]),
]

SW_W, SW_H, SW_G = 150, 76, 34
TITLE_W = 250
for li, (title, colour, steps) in enumerate(LANES):
    ly = PIPE_Y + li * (LANE_H + LANE_G)
    add(box(LX, ly, W - 2 * LX, LANE_H, WHITE, HAIR, 1.5, 14))
    add(f'<rect x="{LX}" y="{ly}" width="7" height="{LANE_H}" rx="3.5" fill="{colour}"/>')
    tc = F3T if colour == F3 else colour
    add(txt(LX + 26, ly + LANE_H / 2 + 7, title, 19, tc, 700, anchor="start"))
    sx = LX + TITLE_W
    sy = ly + (LANE_H - SW_H) / 2
    for si, (ic, lb, (fill, stroke)) in enumerate(steps):
        add(box(sx, sy, SW_W, SW_H, fill, stroke, 1.5, 11))
        icol = CF_DEEP if fill == CF_FILL else MUTED
        add(both_icon(sx + 32, sy + SW_H / 2, icol) if ic == "both"
            else icon(ic, sx + 32, sy + SW_H / 2, icol, 0.86))
        add(txt(sx + 58, sy + SW_H / 2 + 5, lb, 14.5, INK, 700, anchor="start"))
        if si < len(steps) - 1:
            add(wire(f"M{sx + SW_W + 6} {sy + SW_H / 2} L{sx + SW_W + SW_G - 6} {sy + SW_H / 2}",
                     colour, 3))
        sx += SW_W + SW_G

add("</svg>")
svg = "\n".join(P)

# =======================================================================================
# below the fold: everything the poster deliberately does not say
# =======================================================================================
PRODUCTS = [
    ("Workers", "3 deployed: front door, designer-agent, xr", "workers/wrangler.toml:14 · apps/xr/wrangler.toml:12 · services/agent/wrangler.toml:4"),
    ("Durable Objects", "RoomAgent, ScoutAgent, MeshDispatcher, DesignerAgent", "workers/wrangler.toml:120,128 new_sqlite_classes"),
    ("Workflows", "generate-mesh, ingest-merchant — per-step durable retry", "workers/wrangler.toml:95-103"),
    ("Queues", "full-scale-jobs, 1 consumer, 3 retries", "workers/wrangler.toml:83-92"),
    ("Cron Triggers", "drains the D1 outbox every 60 s", "workers/wrangler.toml:28 crons = [\"* * * * *\"]"),
    ("Workers AI", "@cf/openai/gpt-oss-120b — emits a plan, never a coordinate", "workers/wrangler.toml:69 · workers/src/lib/ai.ts:12,15"),
    ("Agents SDK", "four agent classes: memory, tool loop, per-agent SQL", "workers/package.json:24 agents ^0.24.0"),
    ("Browser Rendering", "reads a storefront that serves no product JSON", "workers/wrangler.toml:75 · src/agents/scout-agent.ts:393"),
    ("D1", "full-scale-db — rooms, versions, objects, jobs, mesh_outbox", "workers/wrangler.toml:44-46"),
    ("R2", "full-scale-objects — private, served via GET /v1/assets/{key}", "workers/wrangler.toml:39-41"),
    ("Workers KV", "CONFIG — tunnel origins, encoder fingerprint, upload grants", "workers/wrangler.toml:52-53"),
    ("Vectorize", "objects-v1, 768-dim SigLIP 2 — style vector + w/h/d_mm $lte", "workers/wrangler.toml:59-61"),
    ("Static Assets", "the WebXR page itself, on a secure origin", "apps/xr/wrangler.toml [assets]"),
    ("Service Bindings", "API, AGENT — worker to worker, no public hop", "apps/xr/wrangler.toml [[services]]"),
    ("Cloudflare Tunnel", "the only route to the laptop; no open port, no inbound DNS", "infra/up.sh · infra/gen-up.sh"),
    ("Workers Observability", "logs for all three Workers", "[observability] in all 3 wrangler files"),
]
SPONSORS = [
    ("Cloudflare", "workers/ · apps/xr/ · services/agent/", "16 products: the whole runtime, state, storage, search, orchestration and both agents"),
    ("Expo", "apps/mobile/app.json — SDK 57, 3 config plugins", "The iOS app and four Swift modules: RoomPlan, Object Capture, depth measure, Speech"),
    ("Shopify", "services/ingest/verify_merchants.py · README.md:128", "Public /products.json and /collections/&lt;handle&gt;/products.json are the catalogue source"),
    ("Browserbase", "services/ingest/app/browserbase.py · page_extract.py", "Renders the product pages whose dimensions live in metafields that JSON never serves"),
    ("Baseten", "services/gen/app/generate_server.py · Dockerfile.adapter", "SF3D image-to-3D on an L4, behind the adapter that binds metric scale exactly once"),
    ("OpenAI", "services/agent/src/agent.ts · services/ingest/app/ai_extract.py", "The layout planner in designer-agent, and the LLM/VLM dimension passes in extraction"),
    ("ElevenLabs", "apps/xr/worker/index.ts — /v1/voice/stt, /v1/voice/tts", "Headset speech in and speech out; the API key never leaves the Worker"),
]
CAVEATS = [
    ("POST /v1/solve", "RoomAgent + Workers AI, the front door's own agent. Built; the headset uses designer-agent today."),
    ("services/search :8005", "Standby ranker. workers/src/routes/index.ts:551 only calls it when upstream:embedding is unset — live search runs on Vectorize inside the Worker."),
    ("gen adapter :8006", "Live on the laptop with its own tunnel. The Worker secret BASETEN_URL is unset, so mesh jobs park durably in the Queue. BASETEN_URL names the adapter, never Baseten."),
]

rows = lambda xs: "\n".join(
    f"<tr><td class='k'>{a}</td><td>{b}</td><td class='m'>{c}</td></tr>" for a, b, c in xs)

DETAILS = f"""
<section class="details">
  <h2>Cloudflare products in use: 16</h2>
  <table><thead><tr><th>Product</th><th>What it does here</th><th>Proof</th></tr></thead>
  <tbody>{rows(PRODUCTS)}</tbody></table>

  <h2>Sponsors</h2>
  <p class="note">Nothing is listed that the code does not call. Sponsors whose technology this
  project does not use are deliberately absent.</p>
  <table><thead><tr><th>Sponsor</th><th>Where in the repo</th><th>What it does</th></tr></thead>
  <tbody>{rows([(a, c, b) for a, b, c in SPONSORS])}</tbody></table>

  <h2>Built, but not on the demo path</h2>
  <table><thead><tr><th>Thing</th><th>Status</th><th></th></tr></thead>
  <tbody>{"".join(f"<tr><td class='k'>{a}</td><td colspan='2'>{b}</td></tr>" for a, b in CAVEATS)}</tbody></table>

  <p class="note">Verified against the deployed system, 2026-09-20 06:25 UTC. The front door
  answers 30 routes (<code>workers/src/index.ts:201-257</code>).</p>
</section>
"""

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
  html, body {{ margin: 0; padding: 0; background: {BG}; color: {INK}; }}
  body {{ font-family: {SANS}; }}
  svg {{ display: block; width: 100%; height: auto; }}
  .details {{ max-width: 1800px; margin: 0 auto; padding: 8px 60px 80px; }}
  .details h2 {{ font-size: 22px; font-weight: 700; margin: 44px 0 12px; }}
  .details h2:first-child {{ margin-top: 8px; }}
  .note {{ font-size: 14px; color: {MUTED}; margin: 0 0 14px; max-width: 900px; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 14px; }}
  th {{ text-align: left; font-size: 11.5px; letter-spacing: 1.2px; text-transform: uppercase;
        color: {MUTED}; border-bottom: 1.5px solid {HAIR}; padding: 0 16px 8px 0; }}
  td {{ padding: 9px 16px 9px 0; border-bottom: 1px solid {HAIR}; vertical-align: top; }}
  td.k {{ font-weight: 700; white-space: nowrap; }}
  td.m, code {{ font-family: {MONO}; font-size: 12.5px; color: {CF_DEEP}; }}
</style>
</head>
<body>
{svg}
{DETAILS}
</body>
</html>
"""

OUT.write_text(HTML, encoding="utf-8")
print(f"wrote {OUT} ({len(HTML)} bytes) poster {W}x{H}")
