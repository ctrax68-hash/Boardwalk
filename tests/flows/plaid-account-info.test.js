// Verifies real institution name + account/balance data reach the client
// (not a raw Plaid institution_id string) both on a fresh Hosted Link merge
// and via sync()'s self-heal path for a legacy bank record that predates
// this fix (no item_id, institution stored as a raw string, no accounts).
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('plaid-account-info');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);

    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    // 1. onHostedLinkReturn merge builds a real institution object + accounts,
    //    not a bare institution_id string with an empty accounts array.
    const mergeResult = await page.evaluate(async () => {
      localStorage.setItem('kevt_plaid_hosted_link_pending', JSON.stringify({ ts: Date.now(), household_id: 'hh1' }));
      _v2Session = { access_token: 'fake-token' };
      _v2Household = { id: 'hh1' };
      var origFetch = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('get-connected-banks') !== -1) {
          return Promise.resolve({ json: () => Promise.resolve({ banks: [{
            id: 'srv_bank_2', item_id: 'item_abc', institution_id: 'ins_3',
            institution_name: 'Chase', updated_at: new Date().toISOString(),
            accounts: [{ account_id: 'acc1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1234', balances: { current: 500 } }]
          }] }) });
        }
        if (String(url).indexOf('sync-plaid-transactions') !== -1) {
          return Promise.resolve({ json: () => Promise.resolve({ added: [], modified: [], removed: [], items: [] }) });
        }
        return origFetch(url, opts);
      };
      PlaidLinkManager.checkPendingHostedLink();
      await new Promise(function (resolve) { setTimeout(resolve, 2500); });
      var state = PlaidLinkManager.getState();
      window.fetch = origFetch;
      var bank = state.banks[state.banks.length - 1];
      return {
        institutionName: bank && bank.institution && bank.institution.name,
        institutionIsObject: bank && typeof bank.institution === 'object',
        accountCount: bank && bank.accounts ? bank.accounts.length : 0,
        itemId: bank && bank.item_id,
      };
    });
    check('Merged bank has real institution name (not raw institution_id)', mergeResult.institutionName === 'Chase', mergeResult);
    check('Merged bank institution is an object (matches _onSuccess shape)', mergeResult.institutionIsObject === true, mergeResult);
    check('Merged bank has accounts populated from server', mergeResult.accountCount === 1, mergeResult);
    check('Merged bank has item_id stored', mergeResult.itemId === 'item_abc', mergeResult);

    // 2. sync() self-heals a legacy bank with no item_id (the exact broken
    //    state a bank connected before this fix would be in) — single-bank
    //    fallback should adopt the one returned item.
    const healResult = await page.evaluate(async () => {
      localStorage.setItem('kevt_plaid_multi', JSON.stringify([{
        id: 'srv_legacy_1', institution: 'ins_3', accounts: [], lastSync: '2026-07-08T15:53:00Z',
      }]));
      PlaidLinkManager.load();
      var origFetch = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('sync-plaid-transactions') !== -1) {
          return Promise.resolve({ json: () => Promise.resolve({
            added: [], modified: [], removed: [],
            items: [{ item_id: 'item_legacy_real', institution_name: 'Wells Fargo', accounts: [
              { account_id: 'acc9', name: 'Savings', type: 'depository', subtype: 'savings', mask: '9876', balances: { current: 1200 } },
            ], next_cursor: 'cur1' }],
          }) });
        }
        return origFetch(url, opts);
      };
      var before = JSON.parse(JSON.stringify(PlaidLinkManager.getState().banks[0]));
      await PlaidLinkManager.sync();
      var after = PlaidLinkManager.getState().banks[0];
      window.fetch = origFetch;
      return {
        beforeInstitution: before.institution,
        beforeAccountCount: (before.accounts || []).length,
        afterInstitutionName: after.institution && after.institution.name,
        afterAccountCount: (after.accounts || []).length,
        afterItemId: after.item_id,
      };
    });
    check('Legacy bank started broken (raw string institution, no accounts)', healResult.beforeInstitution === 'ins_3' && healResult.beforeAccountCount === 0, healResult);
    check('sync() self-heals institution name for legacy bank', healResult.afterInstitutionName === 'Wells Fargo', healResult);
    check('sync() self-heals account list for legacy bank', healResult.afterAccountCount === 1, healResult);
    check('sync() backfills item_id for legacy bank', healResult.afterItemId === 'item_legacy_real', healResult);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
