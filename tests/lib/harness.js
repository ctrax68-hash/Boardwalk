// Shared checker + browser-page setup for flow tests. Follows one pattern
// everywhere: each flow test file exports `run(baseUrl)` returning
// { ok, passed, total, checks } from a checker created here.
const { chromium, devices } = require('playwright');

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function makeChecker(label) {
  const checks = [];
  function check(name, ok, detail) {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}${detail !== undefined ? ': ' + safeJson(detail) : ''}`);
  }
  function summary() {
    const passed = checks.filter(c => c.ok).length;
    return { label, checks, passed, total: checks.length, ok: checks.length > 0 && passed === checks.length };
  }
  return { check, summary };
}

// The app's boot sequence resolves auth (a real Supabase round-trip) before
// falling back to guest mode and running PlaidLinkManager.load(), which
// takes ~2.5-3s in practice. Checking household/Plaid state before this
// settles looks like a false regression — see .claude/skills/verify/SKILL.md.
const BOOT_SETTLE_MS = 3500;

async function newPage(opts) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true, ...(opts && opts.contextOverrides) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('ERR_TUNNEL')) errors.push('CONSOLE: ' + msg.text());
  });
  return { browser, context, page, errors };
}

async function gotoAndBoot(page, baseUrl, opts) {
  const nav = await page.goto(baseUrl + '/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout((opts && opts.bootWaitMs) || BOOT_SETTLE_MS);
  return nav;
}

module.exports = { makeChecker, newPage, gotoAndBoot, safeJson, BOOT_SETTLE_MS };
