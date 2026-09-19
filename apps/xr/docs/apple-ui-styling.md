# Apple-Style UI Styling Guide (for Web)

A practical reference for building web interfaces that feel at home next to iOS and macOS apps. Values are drawn from Apple's Human Interface Guidelines (HIG) and system defaults, translated into CSS. Treat this as a design-token source you can drop into a project or hand to a coding assistant.

> Note: SF Pro and SF Mono are licensed for use on Apple platforms. On the web, reference them through the system font stack (`-apple-system`) rather than self-hosting them.

---

## 1. Core principles

1. **Content first.** Chrome recedes; UI uses translucency, generous whitespace and quiet color so the content carries the screen.
2. **Clarity.** Legible text at every size, precise icons, one clear primary action per view.
3. **Depth through layers.** Hierarchy comes from materials (blur), elevation and motion rather than heavy borders or shadows.
4. **Consistency.** System colors, system type sizes and familiar controls. Users should never have to learn your button.
5. **Adaptivity.** Every screen works in light and dark mode, at larger text sizes, with reduced motion and reduced transparency.

---

## 2. Typography

### Font stack

```css
--font-text: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Inter", system-ui, sans-serif;
--font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Inter", system-ui, sans-serif;
--font-rounded: ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif;
--font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
```

### Type scale (iOS default "Large" Dynamic Type)

| Style        | Size | Weight   | Line height | Tracking  |
|--------------|------|----------|-------------|-----------|
| Large Title  | 34px | 700      | 41px        | 0.37px    |
| Title 1      | 28px | 700      | 34px        | 0.36px    |
| Title 2      | 22px | 700      | 28px        | 0.35px    |
| Title 3      | 20px | 600      | 25px        | 0.38px    |
| Headline     | 17px | 600      | 22px        | -0.43px   |
| Body         | 17px | 400      | 22px        | -0.43px   |
| Callout      | 16px | 400      | 21px        | -0.31px   |
| Subheadline  | 15px | 400      | 20px        | -0.23px   |
| Footnote     | 13px | 400      | 18px        | -0.08px   |
| Caption 1    | 12px | 400      | 16px        | 0px       |
| Caption 2    | 11px | 400      | 13px        | 0.06px    |

For macOS-density interfaces, body text drops to **13px** and controls shrink accordingly.

### Rules

- Use weight and size for hierarchy, not color alone. Secondary text uses `--label-secondary`, never a random grey.
- Sentence case for buttons, titles and labels ("Add to list", not "ADD TO LIST" or "Add To List").
- Avoid Light/Thin weights below 20px.
- Size text in `rem` so it respects user font-size settings (the web analog of Dynamic Type).
- Use `font-variant-numeric: tabular-nums;` for numbers that change (timers, prices, tables).

---

## 3. Color

### System accent colors

| Name    | Light     | Dark      |
|---------|-----------|-----------|
| Blue    | `#007AFF` | `#0A84FF` |
| Green   | `#34C759` | `#30D158` |
| Indigo  | `#5856D6` | `#5E5CE6` |
| Orange  | `#FF9500` | `#FF9F0A` |
| Pink    | `#FF2D55` | `#FF375F` |
| Purple  | `#AF52DE` | `#BF5AF2` |
| Red     | `#FF3B30` | `#FF453A` |
| Teal    | `#30B0C7` | `#40CBE0` |
| Yellow  | `#FFCC00` | `#FFD60A` |

Pick **one** accent (tint color) for interactive elements across the whole app. Red is reserved for destructive actions; green for success/on states.

### Greys

| Name   | Light     | Dark      |
|--------|-----------|-----------|
| Gray   | `#8E8E93` | `#8E8E93` |
| Gray 2 | `#AEAEB2` | `#636366` |
| Gray 3 | `#C7C7CC` | `#48484A` |
| Gray 4 | `#D1D1D6` | `#3A3A3C` |
| Gray 5 | `#E5E5EA` | `#2C2C2E` |
| Gray 6 | `#F2F2F7` | `#1C1C1E` |

### Semantic colors

| Token                       | Light                        | Dark                          |
|-----------------------------|------------------------------|-------------------------------|
| Background (primary)        | `#FFFFFF`                    | `#000000`                     |
| Background (secondary)      | `#F2F2F7`                    | `#1C1C1E`                     |
| Background (tertiary)       | `#FFFFFF`                    | `#2C2C2E`                     |
| Grouped background          | `#F2F2F7`                    | `#000000`                     |
| Grouped cell background     | `#FFFFFF`                    | `#1C1C1E`                     |
| Label                       | `#000000`                    | `#FFFFFF`                     |
| Secondary label             | `rgba(60,60,67,0.60)`        | `rgba(235,235,245,0.60)`      |
| Tertiary label              | `rgba(60,60,67,0.30)`        | `rgba(235,235,245,0.30)`      |
| Quaternary label            | `rgba(60,60,67,0.18)`        | `rgba(235,235,245,0.16)`      |
| Separator                   | `rgba(60,60,67,0.29)`        | `rgba(84,84,88,0.60)`         |
| Opaque separator            | `#C6C6C8`                    | `#38383A`                     |
| Fill (primary)              | `rgba(120,120,128,0.20)`     | `rgba(120,120,128,0.36)`      |
| Fill (secondary)            | `rgba(120,120,128,0.16)`     | `rgba(120,120,128,0.32)`      |
| Fill (tertiary)             | `rgba(118,118,128,0.12)`     | `rgba(118,118,128,0.24)`      |
| Fill (quaternary)           | `rgba(116,116,128,0.08)`     | `rgba(118,118,128,0.18)`      |

Dark mode is not "inverted light mode": base backgrounds go true black, and elevated surfaces get *lighter* (`#1C1C1E` → `#2C2C2E`) instead of relying on shadows.

---

## 4. Spacing & layout

- **Base unit:** 4px, with 8px as the everyday step. Scale: `4, 8, 12, 16, 20, 24, 32, 44`.
- **Screen margins:** 16px on phones, 20px on larger phones/tablets in portrait, readable-width containers (~672px max for text) on desktop.
- **Minimum hit target:** 44 × 44px for anything tappable, even if the visible glyph is smaller.
- **List rows:** minimum 44px tall; 11px vertical padding for single-line rows; separators inset to align with the text, not the icon.
- **Inset grouped lists:** 16–20px side margin, 10–12px corner radius, 35px gap between sections, section headers in Footnote uppercase-free secondary label.

### Corner radii

| Element                    | Radius           |
|----------------------------|------------------|
| Small controls, tags       | 6–8px            |
| Buttons (standard)         | 10–12px          |
| Buttons (prominent/pill)   | `9999px` capsule |
| Grouped list sections      | 10–12px          |
| Cards / tiles              | 16–20px          |
| Sheets (top corners)       | 10–16px          |
| App-icon style squares     | ~22.4% of width  |

Apple uses continuous ("squircle") corners. Where supported, enhance with `corner-shape: squircle;` and fall back to `border-radius`.

Nest radii correctly: inner radius = outer radius − padding.

---

## 5. Materials (translucency)

Bars, sidebars, popovers and sheets sit on blurred, vibrant backgrounds.

```css
.material-regular {
  background: rgba(255, 255, 255, 0.72);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
}
@media (prefers-color-scheme: dark) {
  .material-regular { background: rgba(30, 30, 30, 0.72); }
}

.material-thin  { background: rgba(255,255,255,0.55); backdrop-filter: saturate(180%) blur(12px); }
.material-thick { background: rgba(255,255,255,0.85); backdrop-filter: saturate(180%) blur(30px); }

@media (prefers-reduced-transparency: reduce) {
  .material-regular, .material-thin, .material-thick {
    background: var(--bg-secondary);
    backdrop-filter: none;
  }
}
```

**Liquid Glass (iOS 26 / macOS Tahoe era):** controls and bars float above content as rounded, highly translucent glass with specular edge highlights. A web approximation: a strong blur, low-opacity fill, a 1px inner highlight (`inset 0 1px 0 rgba(255,255,255,0.5)`) and a soft outer shadow. Use it only for the navigation layer, never for content.

---

## 6. Elevation & shadow

Shadows are soft, wide and low-contrast. Prefer material and color changes over shadow.

```css
--shadow-1: 0 1px 2px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.04);
--shadow-2: 0 4px 12px rgba(0,0,0,0.08);
--shadow-3: 0 12px 32px rgba(0,0,0,0.12);   /* popovers, menus */
--shadow-4: 0 24px 64px rgba(0,0,0,0.18);   /* sheets, modals */
```

In dark mode, shadows mostly disappear; elevation is carried by lighter surface colors.

---

## 7. Motion

- Motion is physical and interruptible: things spring, they don't "ease-in-out".
- Typical durations: **200–350ms** for UI transitions, **~500ms** for sheets and larger moves.
- Standard curves:

```css
--ease-standard: cubic-bezier(0.25, 0.1, 0.25, 1);
--ease-sheet:    cubic-bezier(0.32, 0.72, 0, 1);   /* iOS sheet / drawer feel */
--ease-spring:   linear(0, 0.35 12%, 0.82 28%, 1.02 42%, 1.01 55%, 1);
```

- Press feedback: scale to ~0.97 or dim to 0.7 opacity on `:active`, instantly; release with the spring.
- Always honor reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 8. Components

### Navigation bar
- 44px tall (standard) or with a **Large Title** (34px bold) that collapses into an inline 17px semibold title on scroll.
- Background: material; hairline separator (`0.5px`, `--separator`) appears only once content scrolls under it.
- Back button: chevron + previous screen's title, tinted with the accent.

### Tab bar
- 49px tall plus safe-area inset; 3–5 items; icon (~25px) above a 10px medium label.
- Selected item uses the accent; others use `--gray`.

### Buttons

| Style     | Background              | Text              |
|-----------|-------------------------|-------------------|
| Filled    | accent                  | white, 600        |
| Tinted    | accent at 15% opacity   | accent, 600       |
| Gray      | `--fill-tertiary`       | accent, 600       |
| Plain     | transparent             | accent, 400       |
| Destructive | red (filled or plain) | white / red       |

Sizes: small 28px, medium 34px, large 50px tall. Labels are short verbs in sentence case ("Save", "Add photo").

### Lists (inset grouped)
- Row: optional 29px rounded-square icon with colored background, label in Body, value in secondary label, trailing chevron `›` in tertiary label.
- Separators inset from the leading edge of the text.
- Section header/footer in Footnote, secondary label, 16px from the edge.

### Toggle (switch)
- 51 × 31px track, 27px white knob with a soft shadow; on = green (or accent), off = `--fill-primary`.

### Segmented control
- 32px tall, `--fill-tertiary` track, 8–9px radius; selected segment is a raised white (dark: `#636366`) pill with `--shadow-1`, 13px medium label.

### Text fields
- 36–44px tall, `--fill-tertiary` background or no background inside grouped rows, 10px radius, placeholder in tertiary label, clear button (ⓧ) when non-empty.

### Sheets & modals
- Sheets slide up from the bottom with rounded top corners and a 36 × 5px grabber in `--gray-3`.
- Dim the background with `rgba(0,0,0,0.4)`.
- Alerts: 270px wide, centered, 14px radius, material background, title in Headline, message in Footnote, buttons divided by hairlines; the preferred action is bold.

### Icons
- SF Symbols style: line icons that share the text's weight and optical size, vertically centered on the cap height. On the web, use a comparable outline set with adjustable stroke width, and match stroke to text weight.

---

## 9. Accessibility checklist

- Text contrast ≥ 4.5:1 (3:1 for 18px+ bold / 24px+ regular). Secondary label on white passes only for larger text; check it.
- Visible focus ring for keyboard users: `outline: 3px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 2px;`
- All sizes in `rem`; layout must survive 200% text zoom.
- Respect `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast: more`.
- Never convey state by color alone (pair with an icon, label or position).
- Honor safe areas: `padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);`

---

## 10. Drop-in CSS tokens

```css
:root {
  color-scheme: light dark;

  /* Type */
  --font-text: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Inter", system-ui, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Inter", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;

  /* Accent */
  --accent: #007AFF;
  --red: #FF3B30;
  --green: #34C759;
  --orange: #FF9500;

  /* Surfaces */
  --bg-primary: #FFFFFF;
  --bg-secondary: #F2F2F7;
  --bg-tertiary: #FFFFFF;
  --bg-grouped: #F2F2F7;
  --bg-grouped-cell: #FFFFFF;

  /* Labels */
  --label: #000000;
  --label-secondary: rgba(60,60,67,0.60);
  --label-tertiary: rgba(60,60,67,0.30);
  --label-quaternary: rgba(60,60,67,0.18);

  /* Lines & fills */
  --separator: rgba(60,60,67,0.29);
  --fill-primary: rgba(120,120,128,0.20);
  --fill-secondary: rgba(120,120,128,0.16);
  --fill-tertiary: rgba(118,118,128,0.12);
  --gray: #8E8E93;
  --gray-3: #C7C7CC;

  /* Shape & space */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 20px;
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px;
  --hit-target: 44px;

  /* Motion */
  --ease-standard: cubic-bezier(0.25, 0.1, 0.25, 1);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);
  --dur-fast: 200ms;
  --dur-base: 300ms;
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent: #0A84FF;
    --red: #FF453A;
    --green: #30D158;
    --orange: #FF9F0A;

    --bg-primary: #000000;
    --bg-secondary: #1C1C1E;
    --bg-tertiary: #2C2C2E;
    --bg-grouped: #000000;
    --bg-grouped-cell: #1C1C1E;

    --label: #FFFFFF;
    --label-secondary: rgba(235,235,245,0.60);
    --label-tertiary: rgba(235,235,245,0.30);
    --label-quaternary: rgba(235,235,245,0.16);

    --separator: rgba(84,84,88,0.60);
    --fill-primary: rgba(120,120,128,0.36);
    --fill-secondary: rgba(120,120,128,0.32);
    --fill-tertiary: rgba(118,118,128,0.24);
    --gray-3: #48484A;
  }
}

html {
  font-family: var(--font-text);
  font-size: 100%;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
  background: var(--bg-primary);
  color: var(--label);
}

body {
  font-size: 1.0625rem;      /* 17px Body */
  line-height: 1.294;        /* 22px */
  letter-spacing: -0.026em;  /* ≈ -0.43px */
}
```

---

## 11. Common mistakes to avoid

- Heavy 1px grey borders around everything. Use grouped backgrounds and hairline separators instead.
- Multiple accent colors competing for attention.
- Title Case or ALL CAPS button labels.
- Hover-only affordances; touch users need visible controls.
- Drop shadows in dark mode doing the job that lighter surfaces should.
- Hit targets smaller than 44px.
- Blur on body content or behind long text (hurts legibility and performance).
- Custom controls that look almost-but-not-quite like system ones; either match closely or be clearly distinct.
