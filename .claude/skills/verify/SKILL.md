---
name: verify
description: Boardwalk-specific recipe for driving the app live during verification. No build step — plain static files served over HTTP and exercised in headless Chromium.
---

# Verifying Boardwalk changes

Boardwalk is a client-side PWA: `index.html` + `app.js` + `plaid.js` +
`styles.css`, no bundler, no build step. `app.js` is a single ~53k-line
file; some modules (currently `PlaidLinkManager`) live in their own
`<script>`-tag file loaded before `app.js` — check `index.html`'s script
order if you add another one.

## Launch

```bash
python3 -m http.server 8901 --bind 127.0.0.1 &   # pick any free port
```

Drive it with Playwright + the pre-installed Chromium (do not run
`playwright install` — see repo-level environment notes):

```js
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext(devices['iPhone 13']); // app is mobile-first
const page = await context.newPage();
await page.addInitScript(() => { localStorage.setItem('kevt_tutorial_done', '1'); }); // skip onboarding
await page.goto('http://127.0.0.1:8901/index.html', { waitUntil: 'load' });
```

Kill the server when done (`pkill -f "http.server 8901"`) — it shares
this session's port namespace.

## The boot-timing gotcha

**Wait ~3.5s after navigation before asserting on any auth/household/Plaid
state.** The boot sequence attempts a real Supabase auth round-trip first;
it falls back to guest mode (`_v2GuestMode = true`) at ~2s, and only then
runs `PlaidLinkManager.load()` and populates household-scoped state.
Checking state at 1-2s reliably shows empty/false and looks like a
regression when it isn't — confirmed via a timing probe during the
`plaid.js` extraction (2026-07). If a check is timing-sensitive, poll
every 500ms instead of guessing a single delay.

## Seeding state for a test

Most persisted client state is plain `localStorage`, set via
`page.addInitScript` (runs before any page script, so it's picked up
by the real boot flow — don't hand-invoke internal load functions):

- `kevt_tutorial_done` = `'1'` — skip the first-run tutorial overlay.
- `kevt_plaid_multi` — JSON array of bank objects
  (`{id, item_id, institution:{name,logo}, accounts:[...], lastSync}`)
  to simulate a connected bank without a real Plaid flow.

For flows needing a session, set `window._v2Session` / `window._v2Household`
via `page.evaluate` after load (there's no way to fully mock Supabase auth
short of a real account).

## Driving real UI, not just calling functions

Bottom nav buttons have `aria-label`s (`"Accounts"`, `"Settings"`, etc.) —
click those (`page.click('[aria-label="Accounts"]')`) rather than
navigating internal state directly, so the same code path a real user hits
gets exercised. Mock `window.fetch` for Supabase edge function calls
(match on URL substring, e.g. `sync-plaid-transactions`) rather than
mocking at a higher level.
