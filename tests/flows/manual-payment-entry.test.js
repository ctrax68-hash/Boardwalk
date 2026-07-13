// Verifies manual transaction entry can now represent a credit card
// payment (type:'payment', excluded from spending totals) instead of only
// income/expense. Also verifies the crash this uncovered: opening the
// Edit modal on an EXISTING type:'payment' transaction (e.g. one already
// correctly classified by the Plaid sync fix) used to throw, because
// setT() indexed CATS['payment'], which doesn't exist — CATS only has
// 'expense'/'income' keys.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('manual-payment-entry');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);
    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    // The crash this session's fix was uncovered by: open the edit modal
    // on an existing type:'payment' transaction. Before the fix, setT('payment')
    // would throw on CATS['payment'].map (undefined).
    const editExistingPaymentResult = await page.evaluate(() => {
      AppState.transactions = [
        { id: 'existing_payment_1', type: 'payment', category: 'Other', amount: 500, date: '2026-07-07', merchantRaw: 'Payment Thank You', mk: '2026-07', _deleted: false },
      ];
      var threw = false, errMsg = null;
      try {
        openModal('existing_payment_1');
      } catch (e) {
        threw = true; errMsg = e.message;
      }
      var catOptions = Array.from(document.getElementById('fcat').options).map(function (o) { return o.value; });
      var bpay = document.getElementById('bpay');
      var bexp = document.getElementById('bexp');
      var binc = document.getElementById('binc');
      closeModal();
      return {
        threw: threw, errMsg: errMsg,
        fT: fT,
        catOptionsNonEmpty: catOptions.length > 0,
        bpayActive: bpay.className.indexOf('ap') !== -1,
        bexpActive: bexp.className.indexOf('ae') !== -1,
        bincActive: binc.className.indexOf('ai') !== -1,
      };
    });
    check('Opening Edit modal on an existing type:payment transaction does not throw', editExistingPaymentResult.threw === false, editExistingPaymentResult);
    check('Category dropdown is populated (not crashed/empty) for a payment-type transaction', editExistingPaymentResult.catOptionsNonEmpty === true, editExistingPaymentResult);
    check('The CC Payment toggle shows as active, not Expense or Income', editExistingPaymentResult.bpayActive === true && editExistingPaymentResult.bexpActive === false && editExistingPaymentResult.bincActive === false, editExistingPaymentResult);

    // New manual entry: selecting "CC Payment" and saving should produce a
    // real type:'payment' transaction, excluded from expense totals.
    const manualAddResult = await page.evaluate(() => {
      AppState.transactions = [];
      openModal(null); // Add Transaction (no existing id)
      setT('payment');
      document.getElementById('famt').value = '2000';
      document.getElementById('fmer').value = 'Chase Card Payment';
      document.getElementById('fdate').value = '2026-07-10';
      document.getElementById('fcat').value = document.getElementById('fcat').options[0].value;
      saveTx();
      var saved = AppState.transactions[0];
      var monthTxs = AppState.transactions.filter(function (t) { return t.mk === '2026-07'; });
      return {
        savedType: saved ? saved.type : null,
        savedAmount: saved ? saved.amount : null,
        monthlyExpensesExcludesIt: computeMonthlyExpenses(monthTxs),
      };
    });
    check('Manually entering a transaction as "CC Payment" saves it as type:payment', manualAddResult.savedType === 'payment', manualAddResult);
    check('That manually-entered payment is excluded from computeMonthlyExpenses', manualAddResult.monthlyExpensesExcludesIt === 0, manualAddResult);

    // 🔍 Probe: the existing Expense/Income toggle behavior is unaffected.
    const regressionResult = await page.evaluate(() => {
      AppState.transactions = [];
      openModal(null);
      setT('expense');
      var expCategoryCount = document.getElementById('fcat').options.length;
      setT('income');
      var incCategoryCount = document.getElementById('fcat').options.length;
      closeModal();
      return { expCategoryCount: expCategoryCount, incCategoryCount: incCategoryCount };
    });
    check('🔍 Expense/Income category lists are unchanged (still their own distinct lists)', regressionResult.expCategoryCount > 0 && regressionResult.incCategoryCount > 0 && regressionResult.expCategoryCount !== regressionResult.incCategoryCount, regressionResult);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
