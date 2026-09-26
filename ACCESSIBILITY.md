# Accessibility

Vault's dashboard targets **WCAG 2.2 Level AA**. Accessibility is tested automatically on every run of `npm test`, so it can't silently regress.

## How it is verified

| Check | Tool | Result |
|---|---|---|
| Automated WCAG 2.0 / 2.1 / 2.2 A and AA scan of every page, including while nodes are failing | axe-core 4.13 (the engine inside Chrome Lighthouse), in `src/components/__tests__/a11y.test.tsx` | 0 violations |
| Same scan in a real Chrome browser, including rendered color contrast: 5 pages × light and dark × desktop and phone | axe-core in Chromium | 0 violations across all 20 combinations |
| Text contrast of every color token, computed from `global.css` with the WCAG formula | unit tests | All text ≥ 4.5:1, focus ring ≥ 3:1, in both themes |
| Accessibility lint on every component | eslint-plugin-jsx-a11y, **strict** config | 0 problems |
| Keyboard and screen-reader behavior | Testing Library with user-event | Skip link, focus management, labels, live regions, captions |

Run them yourself:

```bash
npm run test:a11y   # accessibility tests only
npm run lint        # jsx-a11y strict lint
```

## What is implemented

**Perceivable**
- All text meets WCAG AA contrast (4.5:1) in both light and dark themes; the lowest ratio is 4.6:1. Button, badge, and focus-ring colors are checked too.
- Status is never conveyed by color alone: every node, piece, and object state also has a text label ("Online", "Declared dead", "Corrupt").
- Charts are `role="img"` with descriptions that include their current values, such as "currently 41 reads per second".
- Tables have captions and header scopes; the piece map exposes each cell's state to screen readers.
- Decorative icons and animations are hidden from assistive technology.
- Supports the system **Increase contrast** setting (`prefers-contrast: more`) and **Windows High Contrast / forced colors**.

**Operable**
- Everything works with the keyboard alone, including fault injection, uploads, and settings.
- A **Skip to main content** link is the first Tab stop.
- A strong, consistent focus ring (3px, ≥ 3:1 contrast) on every interactive element.
- Scrollable areas (event log, node table, piece map) are focusable, so they can be scrolled with the keyboard.
- Respects **Reduce motion**: animations and transitions are disabled.
- Touch targets meet the WCAG 2.2 minimum (24 × 24 px); primary buttons are 36 px tall.
- Works at 400% zoom and on 320 px-wide screens with no horizontal page scrolling.

**Understandable**
- Each page has a unique `<h1>` and browser tab title ("Nodes · Vault").
- After navigation, focus moves to the new page heading so screen readers announce the change.
- Every form control has a visible label; sliders show their current value; policy choices explain their trade-offs.
- Errors (a busy port, a rejected write, an oversized upload) are explained in plain language with the next step.

**Robust**
- Semantic landmarks: `nav`, `header`, `main`, and labelled `section`s.
- Cluster health is announced through a polite live region; the event log is an ARIA log.
- Native HTML controls (buttons, links, radios, checkboxes, ranges) are used instead of custom widgets.

## Known limitation

Dragging a file onto the upload area is a mouse shortcut. Keyboard and screen-reader users get the same result through the labelled file input in that area.