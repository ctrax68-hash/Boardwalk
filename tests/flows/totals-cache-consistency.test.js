// Verifies the fix for two dashboard widgets showing different monthly
// totals after a data correction: the top Income/Expenses card recomputed
// fresh and showed the corrected total, but a second "THIS MONTH" panel
// (rHomeDashboard -> computeMonthlyExpenses) kept showing the old total
// because that function trusted a possibly-stale getMonthSummary() cache
// entry over the fresh transaction array it was actually given. Also
// verifies the two "clear all caches" functions (cacheInvalidateAll and
// invalidateAllCaches), which used to clear different, overlapping
// subsets of the app's caches, are now both fully comprehensive.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('totals-cache-consistency');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);
    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    // Reproduce the exact staleness scenario: a getMonthSummary cache
    // entry populated BEFORE a data correction (the old, wrong total),
    // then the underlying transactions get fixed (same array length,
    // values changed in place — exactly what the payment-classification
    // repair does), without the cache ever being told to forget.
    const staleResult = await page.evaluate(() => {
      cY = 2026; cM = 6; // July 2026 (0-indexed month)
      AppState.transactions = [
        { id: 't1', type: 'expense', category: 'Shopping', amount: 2670.88, date: '2026-07-05', mk: '2026-07', _deleted: false },
      ];
      // Simulate a stale cache entry as if it were computed before a fix
      // reclassified $3,900 worth of transactions out of 'expense'.
      cacheSet('msumm_2026-07', { key: '2026-07', inc: 0, exp: 6570.88, net: -6570.88, byCat: {}, byMerch: {}, txCount: 3 }, 10 * 60 * 1000);

      var txs = AppState.transactions.filter(function (t) { return t.mk === '2026-07'; });
      return {
        computeMonthlyExpensesResult: computeMonthlyExpenses(txs),
        getMonthSummaryStillCached: getMonthSummary(2026, 6).exp, // confirms the stale entry really is there
      };
    });
    check('getMonthSummary cache genuinely holds the stale $6,570.88 value', staleResult.getMonthSummaryStillCached === 6570.88, staleResult);
    check('computeMonthlyExpenses ignores the stale cache and reflects the real $2,670.88 from the txs it was given', staleResult.computeMonthlyExpensesResult === 2670.88, staleResult);

    // Both cache-clear functions should now be fully comprehensive —
    // clearing a v3_* insight cache entry that only cacheInvalidateAll()
    // used to reach.
    const cacheConsolidationResult = await page.evaluate(() => {
      cacheSet('v3_cashflow', { some: 'stale insight' }, 15 * 60 * 1000);
      var presentBefore = cacheGet('v3_cashflow') !== undefined;
      invalidateAllCaches(); // previously did NOT clear v3_* entries
      var clearedByInvalidateAllCaches = cacheGet('v3_cashflow') === undefined;

      cacheSet('v3_cashflow', { some: 'stale insight again' }, 15 * 60 * 1000);
      cacheInvalidateAll();
      var clearedByCacheInvalidateAll = cacheGet('v3_cashflow') === undefined;

      return { presentBefore: presentBefore, clearedByInvalidateAllCaches: clearedByInvalidateAllCaches, clearedByCacheInvalidateAll: clearedByCacheInvalidateAll };
    });
    check('v3_* insight cache entry exists before either invalidation call', cacheConsolidationResult.presentBefore === true, cacheConsolidationResult);
    check('invalidateAllCaches() now also clears v3_* insight cache entries (previously only cacheInvalidateAll did)', cacheConsolidationResult.clearedByInvalidateAllCaches === true, cacheConsolidationResult);
    check('cacheInvalidateAll() still clears v3_* insight cache entries too', cacheConsolidationResult.clearedByCacheInvalidateAll === true, cacheConsolidationResult);

    // 🔍 Probe: end-to-end through the real repair function — after it
    // runs, computeMonthlyExpenses on the same month should reflect the
    // correction even though a stale msumm_ cache entry still exists.
    const e2eResult = await page.evaluate(() => {
      localStorage.removeItem('kevt_plaid_payment_repair_done_v1');
      AppState.transactions = [
        { id: 'plaid_e2e_1', type: 'expense', category: 'Housing', amount: 2000, date: '2026-07-07', mk: '2026-07', merchantRaw: 'Payment Thank You-Mobile', _updated_at: '2026-07-07T00:00:00.000Z', _deleted: false },
        { id: 'plaid_e2e_2', type: 'expense', category: 'Shopping', amount: 670.88, date: '2026-07-05', mk: '2026-07', merchantRaw: 'Amazon', _updated_at: '2026-07-05T00:00:00.000Z', _deleted: false },
      ];
      // Stale cache reflecting the pre-repair (wrong) total of $2,670.88.
      cacheSet('msumm_2026-07', { key: '2026-07', inc: 0, exp: 2670.88, net: -2670.88, byCat: {}, byMerch: {}, txCount: 2 }, 10 * 60 * 1000);

      repairMisclassifiedPlaidPayments();

      var txs = AppState.transactions.filter(function (t) { return t.mk === '2026-07'; });
      return { expensesAfterRepair: computeMonthlyExpenses(txs) };
    });
    check('🔍 After the repair runs, computeMonthlyExpenses reflects the correction ($670.88, payment excluded) despite a stale cache entry existing', e2eResult.expensesAfterRepair === 670.88, e2eResult);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
