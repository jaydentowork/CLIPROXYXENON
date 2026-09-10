---
name: XENEON EDGE
description: Quota and request monitoring display for the CORSAIR XENEON EDGE at 2560 x 720.
colors:
  graphite-ground: "oklch(0.145 0.008 214)"
  panel: "oklch(0.196 0.010 214)"
  panel-raised: "oklch(0.242 0.012 214)"
  hairline: "oklch(0.318 0.014 214)"
  hairline-soft: "oklch(0.258 0.012 214)"
  ink: "oklch(0.965 0.005 214)"
  ink-muted: "oklch(0.760 0.012 214)"
  ink-faint: "oklch(0.710 0.012 214)"
  verdigris: "oklch(0.800 0.100 187)"
  verdigris-deep: "oklch(0.520 0.080 190)"
  signal-amber: "oklch(0.800 0.128 78)"
  signal-rose: "oklch(0.680 0.168 22)"
  unknown-grey: "oklch(0.560 0.010 214)"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "23px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "ui-sans-serif, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0"
  body:
    fontFamily: "ui-sans-serif, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0"
  label:
    fontFamily: "ui-sans-serif, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0"
  numeral:
    fontFamily: "ui-monospace, Cascadia Mono, Segoe UI Mono, SF Mono, Menlo, Consolas, monospace"
    fontSize: "40px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0"
    fontFeature: "tabular-nums"
rounded:
  panel: "8px"
  control: "6px"
  chip: "4px"
  bar: "5px"
spacing:
  screen-pad: "20px"
  panel-gap: "16px"
  panel-pad: "18px"
  tight: "8px"
components:
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  period-control:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    height: "44px"
  period-control-selected:
    backgroundColor: "{colors.verdigris}"
    textColor: "{colors.graphite-ground}"
    rounded: "{rounded.chip}"
    height: "44px"
  state-chip:
    textColor: "{colors.signal-amber}"
    rounded: "{rounded.chip}"
    padding: "2px 7px"
  quota-bar-track:
    backgroundColor: "{colors.panel-raised}"
    rounded: "{rounded.bar}"
    height: "10px"
  quota-bar-fill:
    backgroundColor: "{colors.verdigris}"
    rounded: "{rounded.bar}"
    height: "10px"
---

# Design System: XENEON EDGE

## 1. Overview

**Creative North Star: "The Instrument Panel"**

This is a gauge, not an application. It sits on a wall in the evening, read
from a few feet away while other screens are lit, so the surface is a deep
graphite ground that recedes and every reading steps forward at a size that
survives the distance. Depth comes from tone and hairline rules, never from
shadow or glow. Nothing moves except the numbers that actually changed.

The system is deliberately candid. A value it does not have is the word
Unknown, an aged value carries its age and a `stale` chip, and a weighted
average always names its coverage. There is no red-alert theatre and no
placeholder that could be mistaken for a real reading. Color is a
second channel on top of a word, never the only one.

It explicitly rejects the terminal cosplay lane (phosphor green on black,
scanlines, monospace prose) and the SaaS analytics lane (donut charts,
animated counters, gradient hero metrics, glass panels). Familiar
affordances are kept familiar: a plain segmented control, a plain list,
plain text.

**Key Characteristics:**
- Graphite ground, tonal panels, hairline separation, no shadows
- One cool primary (verdigris) plus two state signals (amber, rose)
- Monospace tabular numerals for every quantity, sans for every word
- Fixed 2560 x 720 composition that never scrolls as a page
- Unknown, stale, and coverage labels treated as first-class content

## 2. Colors

A cool graphite instrument in a dark room: near-neutral ground and panels,
with verdigris carrying capacity and warm signals reserved for things that
need attention. The palette is restrained; color covers well under 10% of
the surface at any moment.

### Primary
- **Verdigris** (oklch(0.800 0.100 187)): the capacity color. Quota bar
  fills, the selected period control, the "collecting" status pip, and OK
  results in the live feed.
- **Deep Verdigris** (oklch(0.520 0.080 190)): borders on the simulated-data
  notice and other quiet primary framing. Never used for text.

### Secondary
- **Signal Amber** (oklch(0.800 0.128 78)): degraded states only. Quota under
  25 percent, values flagged `stale`, the disconnected collector pip, the
  API-unreachable banner, and the collection-gap line.

### Tertiary
- **Signal Rose** (oklch(0.680 0.168 22)): hard states only. Exhausted quota
  (0 percent), failed requests, collector errors, and an exhausted-account
  count above zero.

### Neutral
- **Graphite Ground** (oklch(0.145 0.008 214)): the page background.
- **Panel** (oklch(0.196 0.010 214)): provider summaries and the live feed
  frame.
- **Panel Raised** (oklch(0.242 0.012 214)): quota bar tracks and control
  hover backgrounds.
- **Hairline** (oklch(0.318 0.014 214)): control borders and the collector
  pill. **Hairline Soft** (oklch(0.258 0.012 214)): separators inside a panel.
- **Ink** (oklch(0.965 0.005 214)): readings and primary text, at least 12:1
  against the panel.
- **Ink Muted** (oklch(0.760 0.012 214)): labels, models, and secondary text,
  about 7:1 against the ground.
- **Ink Faint** (oklch(0.622 0.012 214)): ages, coverage counts, and column
  headers, about 5:1. This is the floor; nothing readable sits below it.
- **Unknown Grey** (oklch(0.560 0.010 214)): the neutral pip and the dashed
  outline of a quota bar with no reading.

### Named Rules
**The Unknown Is A Word Rule.** A missing reading is never drawn as an empty
bar, a zero, or a full bar. The bar track goes dashed and the value reads
Unknown.

**The Two-Channel Rule.** Verdigris, amber, and rose are always accompanied by
a word: a percentage, `stale`, `Failed`, `exhausted`, or the status label.

## 3. Typography

**Display Font:** system sans stack (Segoe UI Variable Text, Segoe UI, Roboto,
Helvetica Neue, Arial)
**Body Font:** the same stack
**Label/Mono Font:** system monospace stack (Cascadia Mono, Segoe UI Mono,
SF Mono, Menlo, Consolas)

**Character:** one sans family does all the talking and one monospace family
does all the counting, so quantities line up column to column and never jitter
as they change. No display face, no uppercase eyebrows, no negative tracking.

### Hierarchy
- **Display** (600, 23px, 1.2): provider names.
- **Title** (600, 19px, 1.3): the live feed heading.
- **Body** (400, 17px, 1.35): feed rows, period controls, notices.
- **Label** (400, 13-15px, 1.3): quota window names, stat captions, coverage
  counts, column headers, ages. Never smaller than 13px.
- **Numeral** (500, 40px for period totals, 27px for window percentages,
  15px in the feed, tabular figures): every quantity.

### Named Rules
**The Tabular Rule.** Any number that can change gets the monospace stack and
tabular figures, so a refresh cannot shift the layout.

**The One Voice Rule.** One sans family, three weights (400, 500, 600). No
second display face enters a label, a button, or a data cell.

## 4. Elevation

There are no shadows anywhere in this system. Depth is tonal: the ground sits
at the darkest value, panels step up one notch, and the raised tone inside a
panel marks a track or a control hover. Separation is a 1px hairline, never a
glow. On a wall display read at an angle, a shadow would read as grime and a
glow would read as glare.

### Named Rules
**The Flat Rule.** If an element needs to feel closer, raise its tone or add a
hairline. Never add `box-shadow`.

## 5. Components

### Buttons
- **Shape:** 6px control radius, chip radius 4px inside the segmented control.
- **Period control:** an unselected button is transparent with Ink Muted text;
  the selected button is a solid verdigris fill with Graphite Ground text at
  600 weight. Height is exactly 44px with at least 96px of width.
- **Hover / Focus:** hover raises the background to Panel Raised and the text
  to Ink over 160ms. Keyboard focus is a 3px verdigris outline with a 2px
  offset. There is no active/pressed scale or bounce.

### Chips
- **Style:** a 4px radius, transparent background, and a 1px border in the
  chip's own color. The `stale` chip is Signal Amber with a 12px label.
- **State:** chips are status only and are hidden when the condition clears.

### Cards / Containers
- **Corner Style:** 8px for provider panels and the feed frame; nothing larger.
- **Background:** Panel, on the Graphite Ground body.
- **Shadow Strategy:** none; see Elevation.
- **Border:** 1px Hairline Soft. Controls and the status pill use the stronger
  Hairline.
- **Internal Padding:** 18px on all sides, 16px between panels, 14-16px
  between blocks inside a panel.

### Inputs / Fields
Not applicable. This display has no text inputs, no forms, and no settings.
The only controls are the three period buttons.

### Navigation
There is no navigation. The header carries identity, tracking start, freshness,
collection health, and the period control; the board below it is the whole
product. Nothing links anywhere.

### Live feed row
A four-column grid (time, provider and model, tokens, result) on a 36px row
with a soft hairline between rows. Time, tokens, and duration use tabular
figures. Results pair a pip with a word: OK in verdigris, Failed in rose,
Unknown in grey. The list scrolls internally and never scrolls the page.

### Quota bar
A 10px track in Panel Raised with a fill in verdigris, amber under 25 percent,
and rose at zero. A window with no reading draws a dashed Unknown Grey outline
and no fill. The percentage sits above the bar, the coverage count and age
below it, and the reset time at the right of that line.

## 6. Do's and Don'ts

### Do:
- **Do** keep the three provider summaries in the left two thirds and the live
  feed in the right third, all visible together at 2560 x 720 with no page
  scroll.
- **Do** label every partial or aged reading: coverage as "n of m accounts",
  age as "read 2 min ago", and the `stale` chip when the reading is old.
- **Do** keep every interactive target at least 44 x 44 CSS pixels with a
  visible focus ring.
- **Do** write Unknown for a value that does not exist and keep the last good
  reading visible, with its timestamp, when a refresh fails.
- **Do** pair every state color with a word, as the Two-Channel Rule requires.
- **Do** keep quantities in tabular monospace so refreshes never shift layout.

### Don't
- **Don't** use neon-on-black terminal cosplay: no phosphor green, no
  scanlines, no CRT glow, no monospace for prose.
- **Don't** use SaaS analytics theatre: no donut charts, sparkline confetti,
  animated counters, or gradient hero metrics.
- **Don't** use glassmorphism or purple/blue gradient washes.
- **Don't** shout: no full-screen brick-red alerts, no blinking elements, no
  color that carries meaning on its own.
- **Don't** add management controls: no settings drawers, account tables, or
  proxy actions.
- **Don't** use `border-left` or `border-right` above 1px as a colored stripe,
  gradient text, or `box-shadow` elevation.
- **Don't** let text overflow a panel at any width; wrap it or shorten it.
