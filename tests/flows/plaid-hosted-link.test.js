// Verifies the Hosted Link pending-check flow: the mechanism that lets the
// app notice a bank connection that completed server-side (via the
// plaid-webhook SESSION_FINISHED handler) even when the browser lost track
// of the session — the case that matters most for an installed Home Screen
// PWA, where iOS can route an OAuth bank's redirect into a disconnected
// Safari tab instead of back into the app. See PlaidLinkManager in plaid.js
// and plaid-webhook (Supabase edge function) for the two halves of this.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('plaid-hosted-link');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);

    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    const apiExists = await page.evaluate(() => ({
      hasCheckPending: typeof PlaidLinkManager.checkPendingHostedLink === 'function',
      hasOnHostedLinkReturn: typeof PlaidLinkManager.onHostedLinkReturn === 'function',
      hasOpen: typeof PlaidLinkManager.open === 'function',
    }));
    check('PlaidLinkManager exposes checkPendingHostedLink/onHostedLinkReturn/open',
      apiExists.hasCheckPending && apiExists.hasOnHostedLinkReturn && apiExists.hasOpen, apiExists);

    // 1. No pending marker -> silent no-op (no toast shown)
    const noMarkerResult = await page.evaluate(() => {
      localStorage.removeItem('kevt_plaid_hosted_link_pending');
      document.getElementById('toast').className = '';
      document.getElementById('toast').innerHTML = '';
      PlaidLinkManager.checkPendingHostedLink();
      return document.getElementById('toast').className;
    });
    check('No pending marker: checkPendingHostedLink does nothing (no toast)', noMarkerResult === '', { toastClass: noMarkerResult });

    // 2. Expired marker (31 min old) -> also a no-op, and the stale key gets cleaned up
    const expiredResult = await page.evaluate(() => {
      localStorage.setItem('kevt_plaid_hosted_link_pending', JSON.stringify({ ts: Date.now() - 31 * 60 * 1000, household_id: 'hh1' }));
      document.getElementById('toast').className = '';
      document.getElementById('toast').innerHTML = '';
      PlaidLinkManager.checkPendingHostedLink();
      return { toastClass: document.getElementById('toast').className, keyRemains: !!localStorage.getItem('kevt_plaid_hosted_link_pending') };
    });
    check('Expired marker: checkPendingHostedLink does nothing', expiredResult.toastClass === '', expiredResult);
    check('Expired marker: gets cleaned up from localStorage', expiredResult.keyRemains === false, expiredResult);

    // 3. Fresh marker + mocked session + mocked fetch returning a new bank ->
    //    should show the checking toast, merge the bank in, clear the marker.
    const freshResult = await page.evaluate(async () => {
      localStorage.setItem('kevt_plaid_hosted_link_pending', JSON.stringify({ ts: Date.now(), household_id: 'hh1' }));
      _v2Session = { access_token: 'fake-token' };
      _v2Household = { id: 'hh1' };
      var origFetch = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('get-connected-banks') !== -1) {
          return Promise.resolve({ json: () => Promise.resolve({ banks: [{ id: 'srv_bank_1', institution_id: 'ins_chase', updated_at: new Date().toISOString() }] }) });
        }
        return origFetch(url, opts);
      };
      document.getElementById('toast').className = '';
      document.getElementById('toast').innerHTML = '';
      var priorBankCount = PlaidLinkManager.getState().banks.length;
      PlaidLinkManager.checkPendingHostedLink();
      var toastRightAfterCall = document.getElementById('toast').innerHTML;
      await new Promise(function (resolve) { setTimeout(resolve, 2200); }); // past the internal 1500ms delay
      var newState = PlaidLinkManager.getState();
      var markerAfter = localStorage.getItem('kevt_plaid_hosted_link_pending');
      window.fetch = origFetch;
      return {
        priorBankCount: priorBankCount,
        newBankCount: newState.banks.length,
        toastRightAfterCall: toastRightAfterCall,
        markerCleared: markerAfter === null,
      };
    });
    check('Fresh marker: shows "Checking connection status" toast immediately', freshResult.toastRightAfterCall.indexOf('Checking connection status') !== -1, freshResult);
    check('Fresh marker: new bank merged in after webhook-landing delay', freshResult.newBankCount === freshResult.priorBankCount + 1, freshResult);
    check('Fresh marker: pending marker cleared after successful merge', freshResult.markerCleared === true, freshResult);

    // 4. visibilitychange wiring: becoming visible with a fresh marker triggers the check
    const visResult = await page.evaluate(async () => {
      localStorage.setItem('kevt_plaid_hosted_link_pending', JSON.stringify({ ts: Date.now(), household_id: 'hh1' }));
      var origFetch = window.fetch;
      var fetchCalled = false;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('get-connected-banks') !== -1) {
          fetchCalled = true;
          return Promise.resolve({ json: () => Promise.resolve({ banks: [] }) });
        }
        return origFetch(url, opts);
      };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(function (resolve) { setTimeout(resolve, 2200); });
      window.fetch = origFetch;
      return { fetchCalled: fetchCalled };
    });
    check('visibilitychange (hidden->visible) triggers a pending-link check', visResult.fetchCalled === true, visResult);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
