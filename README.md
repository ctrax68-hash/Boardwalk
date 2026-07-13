# Boardwalk Finance
### Rise with the Tide

A personal finance web app built for iOS Safari — budget tracking, spending alerts, analytics, and household management in a single-file progressive web app.

## Features

- **Dashboard** — spending overview, alerts, and bill insights
- **Budgeting** — category budgets with real-time tracking
- **Transactions** — import via Excel/CSV, auto-bucketing, manual entry
- **Analytics** — trends, charts, and category breakdowns
- **Goals** — savings goals with progress tracking
- **Household** — multi-member management with notifications
- **Settings** — accent color, dark mode, data export

## Tech Stack

- Vanilla JavaScript (ES5-compatible for iOS Safari)
- Chart.js 3.9.1
- XLSX 0.18.5
- localStorage for persistence
- No build step — single `index.html` file

## Deployment

Hosted via GitHub Pages. To deploy:

1. Push `index.html` to the `main` branch
2. Enable GitHub Pages in repo Settings → Pages → Source: `main` / `/ (root)`
3. App is live at `https://ctrax68-hash.github.io/Boardwalk/`

## Local Development

No build required. Just open `index.html` in a browser.

```bash
# Optional: serve locally
npx serve .
```

## Testing

A Playwright-based smoke-test suite covers the flows most likely to
silently break: Plaid bank linking/sync/unlink and the privacy lock
screen.

```bash
npm install
npm test
```

See `.claude/skills/verify/SKILL.md` for how to drive the app manually
(local server + headless Chromium recipe, boot-timing notes) when
adding new test coverage.

## iOS Notes

- Add to Home Screen for full-screen PWA experience
- All JS is ES5-compatible (no arrow functions, no template literals, no `const`/`let`)
- File input uses `onclick` pattern (not `onchange`) for iOS Safari compatibility

---

*Boardwalk Finance v1.0 — Rise with the Tide*
