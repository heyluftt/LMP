# LMP design

LMP has one dark look across player, viewers and editor: near-black surfaces with a faint mint and coral glow, mint as the action color and gold as the second highlight. This file records that look so changes stay consistent. It was last reviewed on 2026-11-23 for the 0.3.0 release.

## Colors

| Token | Value | Use |
|---|---|---|
| Background | `#090a0d` | Window and app shell base |
| Deep surface | `#030405`, `#020304` | Video stage, media surfaces |
| Panel tint | `#09100f`, `#08100f`, `#07100e` | Shelves, cards, dock backgrounds |
| Text | `#f7f2eb` | Body text |
| Bright text | `#fff8ee` | Hover and selected states, subtitles |
| Mint (accent) | `#a4ead0` | Primary actions, focus rings, slider thumbs, scrollbars |
| Gold | `#edc578` | Secondary highlight, progress gradients |
| Coral | `#e08b77`, text `#ffb2a6` | Destructive actions and errors |

The app shell background layers a mint glow (`rgba(139, 211, 194, 0.24)`) at the top left and a coral glow (`rgba(224, 139, 119, 0.2)`) at the bottom right over a vertical dark gradient. Muted text and borders use the text color at reduced alpha instead of separate grays.

## Type

- UI: `Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif`. Inter is not bundled, so most Windows machines render Segoe UI.
- Code and the editor: `"Cascadia Code", "JetBrains Mono", Consolas, monospace`.
- Labels and buttons use heavy weights (650 to 850) at small sizes (11 to 13 px).

## Shape and spacing

- Radius: 8 px for controls and cards, 999 px for pills, sliders and scrollbar thumbs, 6 px for small chips such as subtitle backgrounds.
- Gaps: mostly 6, 8 and 10 px.
- The window has no system frame. `src/ui/WindowChrome.tsx` draws the title bar and starts window dragging; edge resizing comes from the native undecorated window.

## Native elements

Defined globally in `src/styles.css`:

- `color-scheme: dark`, mint `::selection` and mint caret.
- Scrollbars: 10 px with a 6 px mint thumb on a faint track, no arrow buttons. WebView2 ignores `::-webkit-scrollbar` rules on any element that also has `scrollbar-color` or `scrollbar-width`, so those two properties only appear in the `@supports not selector(::-webkit-scrollbar)` fallback.
- Range sliders and the library sort select are fully custom (`appearance: none`).
- Focus rings: buttons and sliders show them only after Tab navigation (`html.tastatur`, toggled in `src/main.tsx`). Text fields always show focus.

## Motion

Character: calm and precise, intensity 2 of 4.

| Token | Value |
|---|---|
| `--dauer-kurz` | 140 ms: hover color, small transforms |
| `--dauer-mittel` | 160 ms: mini player chrome |
| `--dauer-lang` | 180 ms: overlay controls, subtitle lift |
| `--kurve-standard` | `ease` |

- Buttons shrink to 97 % while pressed (`scale`, off with reduced motion).
- Video controls fade and slide in and out; subtitles move up while controls are visible (`transform`, not `bottom`).
- The opening state uses a sweep keyframe animation, disabled under `prefers-reduced-motion`.
