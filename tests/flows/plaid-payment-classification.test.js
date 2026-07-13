// Verifies the fix for credit card payments being counted as real spending:
// a real "Payment Thank You" transaction was sign-classified as
// type:'expense' and mapped to category:'Housing', so it inflated the
// monthly Expenses total and the "Housing" budget instead of being
// excluded as a balance payment. Checks (1) the ongoing classification fix
// in _normalizePlaidTx/_mapPlaidCategory, and (2) the one-time repair pass
// for transactions already saved with the bug's output before the fix.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('plaid-payment-classification');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);
    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    // Ongoing fix: drive it through the real sync path (mocked network),
    // not by calling _normalizePlaidTx directly — it's private inside
    // PlaidLinkManager's closure, same as before the file split. A Plaid
    // "Payment" category transaction on a credit account should classify
    // as type:'payment' regardless of amount sign — the whole point is
    // not to trust sign alone anymore.
    const classificationResult = await page.evaluate(async () => {
      localStorage.setItem('kevt_plaid_multi', JSON.stringify([{
        id: 'bank_class_test', item_id: 'item_class_test',
        institution: { name: 'Chase', logo: null },
        accounts: [{ account_id: 'acc_credit_1', name: 'Credit Card', type: 'credit', subtype: 'credit card', mask: '1111', balances: { current: 500 } }],
        lastSync: null,
      }]));
      PlaidLinkManager.load();
      window._v2Session = { access_token: 'fake' };
      window._v2Household = { id: 'hh_class_test' };
      var origFetch = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('sync-plaid-transactions') !== -1) {
          return Promise.resolve({ json: () => Promise.resolve({
            added: [
              { transaction_id: 'ptx_neg', account_id: 'acc_credit_1', amount: -500, date: '2026-07-07', name: 'Payment Thank You-Mobile', category: ['Payment', 'Credit Card'], pending: false },
              { transaction_id: 'ptx_pos', account_id: 'acc_credit_1', amount: 500, date: '2026-07-07', name: 'Payment Thank You-Mobile', category: ['Payment', 'Credit Card'], pending: false },
              { transaction_id: 'ptx_real', account_id: 'acc_credit_1', amount: 42.50, date: '2026-07-07', name: 'Whole Foods', category: ['Shops', 'Groceries'], pending: false },
            ],
            modified: [], removed: [],
            items: [{ item_id: 'item_class_test', institution_name: 'Chase', accounts: [], next_cursor: 'cur1' }],
          }) });
        }
        return origFetch(url, opts);
      };
      await PlaidLinkManager.sync();
      window.fetch = origFetch;
      var byId = {};
      AppState.transactions.forEach(function (t) { byId[t.id] = t; });
      return {
        neg: byId['plaid_ptx_neg'] ? { type: byId['plaid_ptx_neg'].type, category: byId['plaid_ptx_neg'].category } : null,
        pos: byId['plaid_ptx_pos'] ? { type: byId['plaid_ptx_pos'].type, category: byId['plaid_ptx_pos'].category } : null,
        real: byId['plaid_ptx_real'] ? { type: byId['plaid_ptx_real'].type, category: byId['plaid_ptx_real'].category } : null,
      };
    });
    check('Payment-category transaction with negative amount classifies as type:payment', classificationResult.neg && classificationResult.neg.type === 'payment', classificationResult.neg);
    check('Payment-category transaction with POSITIVE amount ALSO classifies as type:payment (category overrides sign)', classificationResult.pos && classificationResult.pos.type === 'payment', classificationResult.pos);
    check('Payment-category transactions no longer get category:Housing', classificationResult.neg && classificationResult.neg.category === 'Other' && classificationResult.pos.category === 'Other', classificationResult);
    check('A real grocery purchase on the same credit account is unaffected (still type:expense)', classificationResult.real && classificationResult.real.type === 'expense' && classificationResult.real.category === 'Food & Dining', classificationResult.real);

    // One-time repair: existing bad records (saved before this fix, with
    // the bug's exact output shape) should get corrected in place.
    const repairResult = await page.evaluate(() => {
      localStorage.removeItem('kevt_plaid_payment_repair_done_v1');
      AppState.transactions = [
        { id: 'plaid_bad1', type: 'expense', category: 'Housing', amount: 2000, date: '2026-07-07', merchantRaw: 'Payment Thank You-Mobile', _updated_at: '2026-07-07T00:00:00.000Z', _deleted: false },
        { id: 'plaid_bad2', type: 'expense', category: 'Housing', amount: 1900, date: '2026-07-07', merchantRaw: 'PAYMENT THANK YOU - WEB', _updated_at: '2026-07-07T00:00:00.000Z', _deleted: false },
        // Should NOT be touched: a real, legitimate housing expense that happens to be Plaid-sourced.
        { id: 'plaid_real_rent', type: 'expense', category: 'Housing', amount: 1500, date: '2026-07-01', merchantRaw: 'Landlord LLC Rent', _updated_at: '2026-07-01T00:00:00.000Z', _deleted: false },
        // Should NOT be touched: not Plaid-sourced (manually entered).
        { id: 'manual_1', type: 'expense', category: 'Housing', amount: 300, date: '2026-07-03', merchantRaw: 'Payment Thank You (manual note)', _updated_at: '2026-07-03T00:00:00.000Z', _deleted: false },
      ];
      var fixedCount = repairMisclassifiedPlaidPayments();
      var byId = {};
      AppState.transactions.forEach(function (t) { byId[t.id] = t; });
      return {
        fixedCount: fixedCount,
        bad1: { type: byId.plaid_bad1.type, category: byId.plaid_bad1.category },
        bad2: { type: byId.plaid_bad2.type, category: byId.plaid_bad2.category },
        realRent: { type: byId.plaid_real_rent.type, category: byId.plaid_real_rent.category },
        manual: { type: byId.manual_1.type, category: byId.manual_1.category },
        repairFlag: localStorage.getItem('kevt_plaid_payment_repair_done_v1'),
      };
    });
    check('Repair fixes exactly the 2 miscategorized Plaid card payments', repairResult.fixedCount === 2, repairResult.fixedCount);
    check('Bad transaction 1 reclassified to type:payment, category:Other', repairResult.bad1.type === 'payment' && repairResult.bad1.category === 'Other', repairResult.bad1);
    check('Bad transaction 2 reclassified to type:payment, category:Other', repairResult.bad2.type === 'payment' && repairResult.bad2.category === 'Other', repairResult.bad2);
    check('🔍 Real Plaid-sourced rent expense is NOT touched (false-positive guard)', repairResult.realRent.type === 'expense' && repairResult.realRent.category === 'Housing', repairResult.realRent);
    check('🔍 Non-Plaid (manual) transaction is NOT touched even with matching name', repairResult.manual.type === 'expense' && repairResult.manual.category === 'Housing', repairResult.manual);
    check('Repair flag set after running', repairResult.repairFlag === '1', repairResult.repairFlag);

    // 🔍 Probe: running it again should be a no-op (flag gates re-processing).
    const secondRunResult = await page.evaluate(() => repairMisclassifiedPlaidPayments());
    check('🔍 Re-running the repair is a no-op (flag already set)', secondRunResult === 0, secondRunResult);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
