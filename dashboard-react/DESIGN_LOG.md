# Design Log — visual redesign (modern/dark → simple/professional)

Styling-only redesign of `dashboard-react/`. No functional, routing, or
data-fetching changes. Direction approved: **light only · neutral-blue accent ·
comfortable density · no branding**. References: Stripe / Linear / GitHub /
GOV.UK restraint.

> Note: the `/frontend-design` skill was **not installed** in this environment,
> so its specific token guidance could not be applied. Substituted the approved
> references + standard restrained-design practice. Flagged at Phase 1.

## Tokens (central) — done
- `index.html`: removed `class="dark"`, body bg `#050712` → `#f8fafc`.
- `globals.css`: rewrote `:root` to a light neutral palette (canvas `#f8fafc`,
  surface `#fff`, text `#111827`, muted `#6b7280`, border `#e5e7eb`, accent blue
  `#2563eb`, subtle accent `#eff6ff`). Charts → blue shades + neutral + 2
  semantic (no rainbow). Removed the `.dark` override block (light only).
- Collapsed `.glass-panel` + `.premium-card` to one flat `.card-surface`
  primitive: white + 1px border, **no shadow / blur / hover-transform**. Added
  opt-in `.card-interactive` (border-darken hover only). Kept the old class
  names so markup inherits without churn.
- `--radius` 0.625rem → 0.5rem; removed unused 3xl/4xl radius tokens.
- `badge.tsx`: `rounded-4xl` pill → `rounded-md`.

## Components

### a. App shell (sidebar + header) — done
- Removed fixed radial-glow + 48px grid background overlays.
- Removed **framer-motion** entirely (active-nav spring + mobile-drawer slide).
  Active nav is now a static `bg-accent` + 2px left blue bar. (No dependency
  removed, just unused.)
- Sidebar: glass/translucent dark → white `bg-card` + 1px border; narrower
  (286→240px, collapsed 88→64px); 14px nav, 56px header.
- Gradient logo block → neutral bordered square + plain wordmark. Removed the
  "Workspace / UK Planning Graph" decorative block and glassy stat chips →
  plain bordered mini-stats.

### b. Card / panel primitives — done
- All pages now use `.card-surface` (white + 1px border, flat). Removed every
  `backdrop-blur`, `shadow-2xl/shadow-cyan`, translucent `bg-white/[0.0xx]`, and
  hover scale/bg-swap. Class sweep confirms none remain in `src/`.

### c. Tables (Applications, Documents) — done
- **Applications: card-stack → table** (the one approved structural shift). Same
  data and navigation; columns Reference · Proposal (+address) · Council ·
  Status · Docs · Updated. 44px comfortable rows, 12px uppercase header, hover
  `bg-secondary`. Whole row navigates; Reference cell is a real `<Link>` for
  keyboard/middle-click.
- **Documents tab → table** (was a 3-col card grid): Document · Type · Date ·
  Hash · Open.
- Status chips: semantic light palette (granted green-700/50, refused red-700/50,
  pending amber-700/50, withdrawn slate-600/100). Council/platform chips are
  **neutral grey** — color now means status only.

### d. Detail page — done
- Flattened header (removed gradient overlays). Stat tiles → plain label/value
  cards. Tabs → **underlined `variant="line"`** (was a glass pill). Confidence
  bar → solid `bg-primary` (was cyan→violet gradient). Download/source buttons →
  solid blue / bordered neutral (no gradients, no scale).

### e. Charts (Analytics) — done
- Recolored to blue-shades + neutral + 2 semantic (`COLORS` rainbow removed).
  Grid `#e5e7eb`, axes `#6b7280`, light tooltip. Removed **framer-motion**
  card-fade-in (and the import) — bundle dropped ~400 modules. Chart types and
  aggregation untouched.

### f. Empty / loading / error states — done
- Loading skeleton: shimmer sweep → calm `animate-pulse` flat blocks (+ removed
  the `shimmer` keyframe). Empty states: removed decorative icon circles/tinted
  panels → flat card + text (one muted icon max). Error state (Overview) uses the
  same flat card.

## Accessibility spot-check
- Contrast (WCAG AA): foreground `#111827` on white ~16:1 ✓; muted `#6B7280` on
  white 4.83:1 / on canvas ~4.6:1 ✓ (≥4.5 body); accent `#2563EB` links 5.17:1 ✓;
  all status chips are -700 text on -50 bg (high contrast) ✓.
- Focus rings kept visible on inputs/selects/buttons/tabs (`focus-visible:ring`
  retained, not removed for "clean").
- Links/buttons remain visually distinct (blue links, bordered/solid buttons) vs
  plain text.

## Divergences from a pure restyle (approved at Phase 1)
- **Removed fabricated content** (not just restyled): KPI `+12.4%` trend badges,
  the static `<Sparkline>`, and the "Signal Quality 86/74/62%" bars + the
  gradient hero on Overview. These were decorative/fake on a trust-critical tool.
- **Applications cards → table**: a layout restructure (same data/links), the one
  agreed exception to "styling only."

## Followups (not done)
- `text-foreground/60` inactive-tab + foreground (not blue) active underline is
  GitHub-style and intentional; switch to blue underline if preferred.
- Table rows navigate on click but the `<tr>` itself isn't keyboard-focusable
  (keyboard users use the Reference `<Link>`). Could add `tabIndex`/`role` if
  full-row keyboard activation is wanted.
- Dead CSS: `.glass-panel`/`.premium-card` aliases are now unused (kept as inert
  safety aliases); can be deleted.
- `minisearch`/search dead code was already dropped in the JS→Vite migration; not
  design scope.
