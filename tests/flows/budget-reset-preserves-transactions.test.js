// Verifies the fix for a real data-loss bug: Settings → Budget Settings →
// "Reset Starter Budget" shows a confirm dialog promising "Your
// transactions will not be affected," but its handler (BudgetSettings.
// _executeReset -> loadStarterTemplate(false)) called the same function
// used to wipe transactions after Clear All Data, so hitting this button
// silently deleted a real household's entire transaction history —
// including everything synced from Plaid — while only meaning to reset
// budget category amounts.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('budget-reset-preserves-transactions');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);
    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    const result = await page.evaluate(() => {
      AppState.transactions = [
        { id: 'plaid_real_1', type: 'expense', category: 'Groceries', amount: 84.12, date: '2026-09-05', mk: '2026-09', merchantRaw: 'Schnucks', _deleted: false },
        { id: 'plaid_real_2', type: 'income', category: 'Income', amount: 2500, date: '2026-09-01', mk: '2026-09', merchantRaw: 'Employer Payroll', _deleted: false },
      ];
      var beforeCount = AppState.transactions.length;
      BudgetSettings._executeReset();
      return {
        beforeCount: beforeCount,
        afterCount: AppState.transactions.length,
        stillHasReal1: AppState.transactions.some(function (t) { return t.id === 'plaid_real_1'; }),
        stillHasReal2: AppState.transactions.some(function (t) { return t.id === 'plaid_real_2'; }),
        budgetsReset: AppState.budgets && AppState.budgets['Mortgage/Rent'] === 1800,
      };
    });
    check('🔍 "Reset Starter Budget" does NOT wipe real transactions', result.afterCount === result.beforeCount && result.stillHasReal1 && result.stillHasReal2, result);
    check('Budget categories are still reset to starter defaults', result.budgetsReset === true, result);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
