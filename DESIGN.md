---
name: XENEON EDGE
description: Liquid-glass quota and request monitoring for the CORSAIR XENEON EDGE.
register: product
---

# Design System: XENEON EDGE

The reference is a dashboard of broad, rounded liquid-glass panels with white
readings, bright fine rims, restrained yellow accents, and segmented gauges.
The monitoring data and existing controls remain the focus.

## Scene and material

- One fixed meadow panorama (`public/1.png`) covers the viewport, with a dark
  gradient at the top to keep the white header readable.
- Liquid glass keeps the scenery visible: a 20% dark green-neutral tint
  (`oklch(0.17 0.012 155 / 0.20)`), a restrained diagonal sheen, fine 32% white
  rims, bright inset top and side highlights, and a soft outer shadow.
- The shared optical filter uses 8px blur, 145% saturation, 82% brightness,
  and a slight contrast lift. Greenery and flowers stay visible through the
  provider cards and live feed. A pointer-following specular sheen sharpens the
  glass without hiding data; text has a small dark shadow.
- Browsers without backdrop filtering use an opaque dark green-neutral surface.
  Settings retain that stronger surface for form readability.
- Primary panels have a 24px radius, reduced to 20px on phones. Insets use 12px.
- Scene, material, signals, spacing, and fonts are defined in `public/style.css`.

## Color and legibility

- Primary text: `oklch(0.99 0 0)`.
- Secondary text: `oklch(0.96 0.005 240)`; supporting text:
  `oklch(0.95 0.006 240)`. Hierarchy also uses size, position, and weight.
- Accent: yellow `oklch(0.87 0.17 94)`; accent text:
  `oklch(0.92 0.14 94)`.
- Collecting and successful requests use green pips. Low quota uses amber,
  failures and exhaustion use rose, and missing readings use neutral grey.
- Every state also has a text label. A missing quota reads **Unknown** and has
  an unfilled dashed track; it is never represented as zero or full capacity.
- Keep body text at least 4.5:1 against its composed surface and large text 3:1.

## Type and layout

Use the system sans family for labels and large readings. Requests, tokens, cache hit,
breakdowns, and quota percentages use tabular figures. Feed quantities retain
the system monospace family for scanning aligned columns.

The 2560 × 720 display shows three selectable provider cards in the left two thirds and the
live feed in the right third, without page scrolling. Panels use a 12px gap and
24px outer padding. Compact-height styles account for larger OS scaling.

Below 1800px the feed follows the providers; the provider grid reflows to the
available width. On phones the panels stack; headline metrics and the breakdown each retain three columns.
The page can scroll on smaller screens. Longer quota lists and the live feed
scroll internally on the EDGE.

## Components

- **Header:** one monitor title, update time, tracking start, collection status,
  period selector, settings, and fullscreen controls. Preview variants and the
  development overlay are not included in the production page.
- **Period selector:** three pill buttons, at least 44px high; an outlined yellow
  thumb indicates the selected period. Keep visible keyboard focus.
- **Provider:** provider name and period, large request/token totals and cache-hit percentage, a subtle
  three-column breakdown (Input, Output, Est. cost), then quota windows.
- **Provider picker:** a card flips on mouse hover to reveal Gemini, Claude,
  ChatGPT, DeepSeek, and Mimo. Each of three independent selections is saved in
  browser storage. The focusable card face opens the picker by click, tap, Enter,
  or Space; Escape or the close button returns to the metrics. Inactive faces are inert and hidden
  from assistive technology. Reduced motion swaps faces instantly. Providers
  without data from the current connection display Unknown rather than zero.
- **Usage-only cards:** MiMo shows Requests and Tokens above the Input / Output / Est. cost detail row and hides cache-hit percentage and quota. OpenCode now uses the full quota layout with Rolling, Weekly, and Monthly windows. Switching providers restores the matching layout. Unpriced models show n/a.
- **Quota gauge:** a 48px-high rounded glass strip with a fine bright rim and a
  soft green fill that fades at its edge. The quota window label sits on the left
  and its remaining percentage on the right, inside the bar. Fill width remains
  the real remaining percentage. Low quota uses amber; Unknown stays unfilled
  with a dashed outline. A compact relative **Updated** age sits beside the
  Remaining quota heading. Compact-height screens use a 44px strip.
- **Model breakdown:** a fine divider below quota separates a per-model table of
  reported tokens and share of the provider tokens on one line, then estimated cost. Rows follow
  Today/Week/Month and the API-key filter, sorted by token usage. Long lists scroll
  inside the glass card; MiMo shows the same section below its usage totals.
  Unpriced models show n/a; incomplete cost estimates say partial. Background
  refreshes preserve the model list's scroll position; changing its scope resets it.
- **Live feed:** time, provider/model, input, output, cached tokens, estimated
  cost, and result. Aliases remain visible when space permits. Smaller displays
  stack provider and model; phones keep Output and Cost, with other token data
  available through the existing titles.
- **Settings:** native modal dialog with a password field for an API key saved in localStorage, Apply filter, and Clear filter controls. Hash the saved key before requesting usage. Preserve focus handling, dismissal, and the active-filter badge; clear old figures when changing keys.
- **Notices:** clearly identify simulated data, unavailable APIs, stale
  readings, partial coverage, and collection gaps. Preserve the last reading
  when collection fails.
- **Cost:** list-price estimates from the existing pricing data; unpriced models
  display n/a. Calendar reporting periods are distinct from quota reset windows.

## Motion and behavior

Counters retain the existing 700ms update tween. Quota fills ease to their new
percentage over 760ms. Newly completed feed rows enter briefly; unchanged rows
stay still. The collector's pip pulses only while collecting. Fine pointers get
a 3px glass lift and 0.8% zoom. Reduced-motion preferences collapse transitions,
remove the lift, and keep the sheen static.

Preserve polling, response ordering, feed scroll/touch stability, period and
caller selection, and fullscreen handling. Keep at least 44 × 44px interactive
targets, visible focus, honest missing-data states, and readable contrast.
