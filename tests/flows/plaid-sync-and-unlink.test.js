// Verifies the cursor-reset / Force Resync / real server-side Unlink
// behavior added after two real production bugs:
//   1. clearAll() wiped local transactions but never reset each bank's
//      Plaid sync cursor, so the next sync legitimately found "nothing
//      changed" and left the store empty forever.
//   2. Both "Unlink" controls (Accounts screen + Settings) only removed
//      the bank from the local list — the Plaid Item and access_token
//      stayed live and billed indefinitely server-side.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('plaid-sync-and-unlink');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => {
    try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {}
    try { localStorage.setItem('kevt_plaid_multi', JSON.stringify([{
      id: 'bank_seed_1', item_id: 'item_seed_1',
      institution: { name: 'Chase', logo: null },
      accounts: [{ account_id: 'acc1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '4321', balances: { current: 2500.55 } }],
      lastSync: new Date(Date.now() - 3600000).toISOString(),
    }])); } catch (e) {}
  });

  try {
    await gotoAndBoot(page, baseUrl);
    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    const bootState = await page.evaluate(() => {
      var s = PlaidLinkManager.getState();
      return { linked: s.linked, bankCount: s.banks.length, firstInstitution: s.banks[0] && s.banks[0].institution && s.banks[0].institution.name };
    });
    check('Seeded bank loaded via real boot', bootState.linked === true && bootState.bankCount === 1 && bootState.firstInstitution === 'Chase', bootState);

    await page.click('[aria-label="Accounts"]');
    await page.waitForTimeout(600);
    const cardHtml = await page.evaluate(() => document.getElementById('plaid-status-card').innerHTML);
    check('Connected Banks card renders with Sync/Unlink/Force Resync wired', !!cardHtml
      && cardHtml.indexOf("PlaidLinkManager.syncBank('bank_seed_1')") !== -1
      && cardHtml.indexOf("PlaidLinkManager.disconnectBank('bank_seed_1')") !== -1
      && cardHtml.indexOf("PlaidLinkManager.forceResyncBank('bank_seed_1')") !== -1);

    // Normal Sync does NOT request a cursor reset.
    const normalSync = await page.evaluate(async () => {
      window._v2Session = { access_token: 'fake' };
      window._v2Household = { id: 'hh_seed' };
      var origFetch = window.fetch;
      var body = null;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('sync-plaid-transactions') !== -1) { body = JSON.parse(opts.body); return Promise.resolve({ json: () => Promise.resolve({ added: [], modified: [], removed: [], items: [] }) }); }
        return origFetch(url, opts);
      };
      var btn = document.querySelector('button[aria-label="Sync this bank"]');
      btn.click();
      await new Promise(r => setTimeout(r, 800));
      window.fetch = origFetch;
      return body;
    });
    check('Normal Sync click sends reset_cursor:false', normalSync && normalSync.reset_cursor === false, normalSync);

    // Force Resync: confirm dialog gates the network call, then confirming sends reset_cursor:true.
    const forceResyncProbe = await page.evaluate(async () => {
      var origFetch = window.fetch;
      var calledBeforeConfirm = false;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('sync-plaid-transactions') !== -1) calledBeforeConfirm = true;
        return origFetch(url, opts);
      };
      var link = document.querySelector('span[aria-label="Force full transaction history resync for this bank"]');
      link.click();
      await new Promise(r => setTimeout(r, 300));
      window.fetch = origFetch;
      return { calledBeforeConfirm: calledBeforeConfirm };
    });
    check('🔍 Force Resync does not hit the network before the confirm dialog is answered', forceResyncProbe.calledBeforeConfirm === false, forceResyncProbe);

    const forceResyncConfirmed = await page.evaluate(async () => {
      var origFetch = window.fetch;
      var body = null;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('sync-plaid-transactions') !== -1) { body = JSON.parse(opts.body); return Promise.resolve({ json: () => Promise.resolve({ added: [], modified: [], removed: [], items: [] }) }); }
        return origFetch(url, opts);
      };
      if (typeof _cfmCb === 'function') _cfmCb(); // confirm dialog's pending callback
      await new Promise(r => setTimeout(r, 800));
      window.fetch = origFetch;
      return body;
    });
    check('Confirming Force Resync sends reset_cursor:true', forceResyncConfirmed && forceResyncConfirmed.reset_cursor === true, forceResyncConfirmed);

    // clearAll()'s force-resync flag: set it manually (simulating what
    // _clearAllWithCloud sets), confirm the NEXT sync honors it and then
    // clears the flag so subsequent syncs go back to normal.
    const flagFlow = await page.evaluate(async () => {
      localStorage.setItem('kevt_plaid_force_resync', '1');
      var origFetch = window.fetch;
      var bodies = [];
      window.fetch = function (url, opts) {
        if (String(url).indexOf('sync-plaid-transactions') !== -1) { bodies.push(JSON.parse(opts.body)); return Promise.resolve({ json: () => Promise.resolve({ added: [], modified: [], removed: [], items: [] }) }); }
        return origFetch(url, opts);
      };
      await PlaidLinkManager.sync();
      var flagAfterFirstSync = localStorage.getItem('kevt_plaid_force_resync');
      await PlaidLinkManager.sync();
      window.fetch = origFetch;
      return { firstCallResetCursor: bodies[0] && bodies[0].reset_cursor, flagAfterFirstSync: flagAfterFirstSync, secondCallResetCursor: bodies[1] && bodies[1].reset_cursor };
    });
    check('Post-clear force-resync flag makes the next sync request reset_cursor:true', flagFlow.firstCallResetCursor === true, flagFlow);
    check('Flag is consumed (cleared) after that sync', flagFlow.flagAfterFirstSync === null, flagFlow);
    check('Next sync after the flag is consumed goes back to reset_cursor:false', flagFlow.secondCallResetCursor === false, flagFlow);

    // Unlink now actually revokes server-side via unlink-plaid-item, not just
    // a local-only removal — this was the fake-button bug fixed this session.
    const unlinkResult = await page.evaluate(async () => {
      var origFetch = window.fetch;
      var calledUrl = null, calledBody = null;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('unlink-plaid-item') !== -1) {
          calledUrl = String(url); calledBody = JSON.parse(opts.body);
          return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
        }
        return origFetch(url, opts);
      };
      var priorCount = PlaidLinkManager.getState().banks.length;
      var btn = document.querySelector('button[aria-label="Disconnect this bank"]');
      btn.click();
      await new Promise(r => setTimeout(r, 800));
      window.fetch = origFetch;
      return { calledUrl: calledUrl, calledBody: calledBody, priorCount: priorCount, afterCount: PlaidLinkManager.getState().banks.length };
    });
    check('Unlink calls unlink-plaid-item (real server-side revoke), not just a local removal', !!unlinkResult.calledUrl, unlinkResult);
    check('Unlink revoke request is scoped to the correct household/item', unlinkResult.calledBody
      && unlinkResult.calledBody.household_id === 'hh_seed' && unlinkResult.calledBody.item_id === 'item_seed_1', unlinkResult);
    check('Bank removed locally after successful server-side revoke', unlinkResult.afterCount === unlinkResult.priorCount - 1, unlinkResult);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
