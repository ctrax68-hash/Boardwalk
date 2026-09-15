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
              // Real-world case: modern Plaid transactions come back with
              // category:null (the legacy field is deprecated) and this is
              // the DEPOSITORY (checking) side of the same bill payment —
              // a debit out of checking, sign-heuristic alone calls this
              // 'expense'. Only the name matches.
              { transaction_id: 'ptx_checking_leg', account_id: 'acc_checking_1', amount: 2700, date: '2026-09-07', name: 'Payment Thank You-Mobile', category: null, personal_finance_category: null, pending: false },
              // Modern taxonomy signal, no legacy category at all.
              { transaction_id: 'ptx_pfc', account_id: 'acc_credit_1', amount: -1400, date: '2026-09-07', name: 'ACH Electronic Payment', category: null, personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }, pending: false },
              // Real-world case: the originating (checking) bank's raw
              // NACHA/ACH descriptor for the SAME payment, worded nothing
              // like "Payment Thank You" — this is what the depository leg
              // actually looked like in production and slipped through v2.
              { transaction_id: 'ptx_ach_epay', account_id: 'acc_checking_1', amount: 1400, date: '2026-09-08', name: 'CHASE CREDIT CRD DES:EPAY ID:XXXXX85264 INDN:COLE A TRACHSEL CO ID:XXXXX39224 WEB', category: null, personal_finance_category: null, pending: false },
              // 🔍 False-positive guard: a real ACH-paid utility bill also
              // carries "DES:EPAY" but has nothing to do with a credit
              // card — must stay a real expense.
              { transaction_id: 'ptx_utility_epay', account_id: 'acc_checking_1', amount: 145.00, date: '2026-09-09', name: 'PECO ENERGY DES:EPAYMENT ID:XXXXX12345 INDN:COLE A TRACHSEL WEB', category: null, personal_finance_category: null, pending: false },
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
        checkingLeg: byId['plaid_ptx_checking_leg'] ? { type: byId['plaid_ptx_checking_leg'].type, category: byId['plaid_ptx_checking_leg'].category } : null,
        pfc: byId['plaid_ptx_pfc'] ? { type: byId['plaid_ptx_pfc'].type, category: byId['plaid_ptx_pfc'].category } : null,
        achEpay: byId['plaid_ptx_ach_epay'] ? { type: byId['plaid_ptx_ach_epay'].type, category: byId['plaid_ptx_ach_epay'].category } : null,
        utilityEpay: byId['plaid_ptx_utility_epay'] ? { type: byId['plaid_ptx_utility_epay'].type, category: byId['plaid_ptx_utility_epay'].category } : null,
      };
    });
    check('Payment-category transaction with negative amount classifies as type:payment', classificationResult.neg && classificationResult.neg.type === 'payment', classificationResult.neg);
    check('Payment-category transaction with POSITIVE amount ALSO classifies as type:payment (category overrides sign)', classificationResult.pos && classificationResult.pos.type === 'payment', classificationResult.pos);
    check('Payment-category transactions no longer get category:Housing', classificationResult.neg && classificationResult.neg.category === 'Other' && classificationResult.pos.category === 'Other', classificationResult);
    check('A real grocery purchase on the same credit account is unaffected (still type:expense)', classificationResult.real && classificationResult.real.type === 'expense' && classificationResult.real.category === 'Food & Dining', classificationResult.real);
    check('🔍 The depository-account leg of a bill payment (name match only, category:null) is classified as type:payment, not expense', classificationResult.checkingLeg && classificationResult.checkingLeg.type === 'payment', classificationResult.checkingLeg);
    check('🔍 personal_finance_category (modern taxonomy, no legacy category) is recognized as a payment', classificationResult.pfc && classificationResult.pfc.type === 'payment', classificationResult.pfc);
    check('🔍 Raw NACHA/ACH "CREDIT CRD DES:EPAY" descriptor is recognized as a card payment', classificationResult.achEpay && classificationResult.achEpay.type === 'payment', classificationResult.achEpay);
    check('🔍 A real ACH-paid utility bill (also has DES:EPAY, but no "credit card") stays a real expense', classificationResult.utilityEpay && classificationResult.utilityEpay.type === 'expense', classificationResult.utilityEpay);

    // One-time repair: existing bad records (saved before this fix, with
    // the bug's exact output shape) should get corrected in place.
    const repairResult = await page.evaluate(() => {
      localStorage.removeItem('kevt_plaid_payment_repair_done_v3');
      AppState.transactions = [
        { id: 'plaid_bad1', type: 'expense', category: 'Housing', amount: 2000, date: '2026-07-07', merchantRaw: 'Payment Thank You-Mobile', _updated_at: '2026-07-07T00:00:00.000Z', _deleted: false },
        { id: 'plaid_bad2', type: 'expense', category: 'Housing', amount: 1900, date: '2026-07-07', merchantRaw: 'PAYMENT THANK YOU - WEB', _updated_at: '2026-07-07T00:00:00.000Z', _deleted: false },
        // 🔍 The depository-leg case from real-world use: category was
        // never 'Housing' to begin with (it's 'Other', since Plaid's
        // legacy category field was null) — v1 of this repair only
        // matched category:'Housing' and would have skipped this entirely.
        { id: 'plaid_bad3', type: 'expense', category: 'Other', amount: 2700, date: '2026-09-07', merchantRaw: 'Payment Thank You-Mobile', _updated_at: '2026-09-07T00:00:00.000Z', _deleted: false },
        // 🔍 The exact real-world transaction this v3 repair targets: the
        // checking-account side, worded as a raw ACH descriptor, still
        // sitting in the household's data as type:expense after v2 ran.
        { id: 'plaid_bad4', type: 'expense', category: 'Other', amount: 1400, date: '2026-09-08', merchantRaw: 'CHASE CREDIT CRD DES:EPAY ID:XXXXX85264 INDN:COLE A TRACHSEL CO ID:XXXXX39224 WEB', _updated_at: '2026-09-08T00:00:00.000Z', _deleted: false },
        // Should NOT be touched: a real, legitimate housing expense that happens to be Plaid-sourced.
        { id: 'plaid_real_rent', type: 'expense', category: 'Housing', amount: 1500, date: '2026-07-01', merchantRaw: 'Landlord LLC Rent', _updated_at: '2026-07-01T00:00:00.000Z', _deleted: false },
        // Should NOT be touched: not Plaid-sourced (manually entered).
        { id: 'manual_1', type: 'expense', category: 'Housing', amount: 300, date: '2026-07-03', merchantRaw: 'Payment Thank You (manual note)', _updated_at: '2026-07-03T00:00:00.000Z', _deleted: false },
        // 🔍 Should NOT be touched: real ACH-paid utility bill, not a card payment.
        { id: 'plaid_utility', type: 'expense', category: 'Other', amount: 145, date: '2026-09-09', merchantRaw: 'PECO ENERGY DES:EPAYMENT ID:XXXXX12345 INDN:COLE A TRACHSEL WEB', _updated_at: '2026-09-09T00:00:00.000Z', _deleted: false },
      ];
      var fixedCount = repairMisclassifiedPlaidPayments();
      var byId = {};
      AppState.transactions.forEach(function (t) { byId[t.id] = t; });
      return {
        fixedCount: fixedCount,
        bad1: { type: byId.plaid_bad1.type, category: byId.plaid_bad1.category },
        bad2: { type: byId.plaid_bad2.type, category: byId.plaid_bad2.category },
        bad3: { type: byId.plaid_bad3.type, category: byId.plaid_bad3.category },
        bad4: { type: byId.plaid_bad4.type, category: byId.plaid_bad4.category },
        realRent: { type: byId.plaid_real_rent.type, category: byId.plaid_real_rent.category },
        manual: { type: byId.manual_1.type, category: byId.manual_1.category },
        utility: { type: byId.plaid_utility.type, category: byId.plaid_utility.category },
        repairFlag: localStorage.getItem('kevt_plaid_payment_repair_done_v3'),
      };
    });
    check('Repair fixes exactly the 4 miscategorized Plaid card payments', repairResult.fixedCount === 4, repairResult.fixedCount);
    check('Bad transaction 1 reclassified to type:payment, category:Other', repairResult.bad1.type === 'payment' && repairResult.bad1.category === 'Other', repairResult.bad1);
    check('Bad transaction 2 reclassified to type:payment, category:Other', repairResult.bad2.type === 'payment' && repairResult.bad2.category === 'Other', repairResult.bad2);
    check('🔍 Bad transaction 3 (depository leg, "Payment Thank You" wording, category was already Other) is fixed', repairResult.bad3.type === 'payment' && repairResult.bad3.category === 'Other', repairResult.bad3);
    check('🔍 Bad transaction 4 (real-world raw ACH "CREDIT CRD DES:EPAY" descriptor) is now also fixed by v3', repairResult.bad4.type === 'payment' && repairResult.bad4.category === 'Other', repairResult.bad4);
    check('🔍 Real Plaid-sourced rent expense is NOT touched (false-positive guard)', repairResult.realRent.type === 'expense' && repairResult.realRent.category === 'Housing', repairResult.realRent);
    check('🔍 Non-Plaid (manual) transaction is NOT touched even with matching name', repairResult.manual.type === 'expense' && repairResult.manual.category === 'Housing', repairResult.manual);
    check('🔍 Real ACH-paid utility bill is NOT touched (has DES:EPAY but not a credit card)', repairResult.utility.type === 'expense' && repairResult.utility.category === 'Other', repairResult.utility);
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
