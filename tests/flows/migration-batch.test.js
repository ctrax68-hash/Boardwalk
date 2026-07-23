// Verifies the batched cloud migration (migrationEngine.run()): a first
// sign-in / reinstall with a large local dataset used to do one SELECT +
// one UPSERT per item sequentially (~600 round trips for 300 items). This
// checks the replacement does one bulk existence-check fetch plus chunked
// bulk upserts instead, while preserving the exact same last-write-wins
// conflict behavior (skip an item if the cloud copy is newer).
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

// Minimal fake matching the real @supabase/supabase-js chainable query
// builder shape closely enough for migrationEngine's usage: .from(table)
// .select().eq().range() (awaited directly — a SELECT) and
// .from(table).upsert(rows, opts) (returns its own promise).
const FAKE_SUPABASE_CLIENT_SETUP = () => {
  window.__mockSelectCalls = [];
  window.__mockUpsertCalls = [];
  window.supabase = {
    createClient: function () {
      return {
        from: function (table) {
          var state = { table: table, filters: {} };
          var builder = {
            select: function () { return builder; },
            eq: function (col, val) { state.filters[col] = val; return builder; },
            range: function (from, to) { state.rangeFrom = from; state.rangeTo = to; return builder; },
            upsert: function (rows) {
              window.__mockUpsertCalls.push({ table: table, rows: rows });
              if (window.__mockUpsertShouldFailOnce && window.__mockUpsertCalls.length === 1) {
                return Promise.resolve({ data: null, error: { message: 'simulated transient failure' } });
              }
              return Promise.resolve({ data: rows, error: null });
            },
            then: function (resolve, reject) {
              window.__mockSelectCalls.push({ table: table, filters: state.filters, rangeFrom: state.rangeFrom, rangeTo: state.rangeTo });
              var resp = window.__mockExistingRows || [];
              return Promise.resolve({ data: resp, error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };
};

async function run(baseUrl) {
  const { check, summary } = makeChecker('migration-batch');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });
  await page.addInitScript(FAKE_SUPABASE_CLIENT_SETUP);

  try {
    await gotoAndBoot(page, baseUrl);
    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    // 306 local transactions, matching the reported real-world case. Two
    // are pre-seeded to already exist in the "cloud" with a newer
    // timestamp than local, to verify the skip-if-newer path still works
    // when resolved in memory instead of via a per-item SELECT.
    const setupResult = await page.evaluate(() => {
      window._v2Session = { access_token: 'fake' };
      window._v2Household = { id: 'hh_mig_test' };
      authState.status = 'authenticated';

      var txns = [];
      for (var i = 0; i < 306; i++) {
        txns.push({
          id: 'tx_' + i,
          amount: 10 + i,
          date: '2026-01-0' + (1 + (i % 9)),
          type: 'expense',
          category: 'Other',
          _updated_at: '2026-07-01T00:00:00.000Z',
          _deleted: false,
        });
      }
      AppState.transactions = txns;
      AppState.goals = [];
      AppState.recurRules = [];
      AppState.budgets = {};

      // These two already exist "in the cloud" with a newer timestamp —
      // should be skipped, not re-uploaded.
      window.__mockExistingRows = [
        { id: 'tx_0', table_name: 'transactions', updated_at: '2026-07-05T00:00:00.000Z' },
        { id: 'tx_1', table_name: 'transactions', updated_at: '2026-07-05T00:00:00.000Z' },
      ];

      try { localStorage.removeItem('kevt_v2_migration_done'); } catch (e) {}

      return { shouldRun: migrationEngine.shouldRun(), txnCount: AppState.transactions.length };
    });
    check('306 unsynced transactions seeded, shouldRun() is true', setupResult.shouldRun === true && setupResult.txnCount === 306, setupResult);

    const runResult = await page.evaluate(async () => {
      await migrationEngine.run();
      var uploadedIds = [];
      window.__mockUpsertCalls.forEach(function (call) {
        call.rows.forEach(function (r) { uploadedIds.push(r.id); });
      });
      return {
        selectCallCount: window.__mockSelectCalls.length,
        upsertCallCount: window.__mockUpsertCalls.length,
        upsertChunkSizes: window.__mockUpsertCalls.map(function (c) { return c.rows.length; }),
        uploadedIds: uploadedIds,
        tx0CloudId: AppState.transactions[0]._cloud_id,
        tx2CloudId: AppState.transactions[2]._cloud_id,
        migrationDone: localStorage.getItem('kevt_v2_migration_done'),
      };
    });

    // 306 transactions + 1 budget blob = 307 tasks; 2 skipped (already
    // newer in "cloud") = 305 to upload. 250-item chunks -> 2 upsert calls.
    check('Existing-row check is ONE bulk SELECT, not 307 individual ones', runResult.selectCallCount === 1, runResult.selectCallCount);
    check('Upload happens in 2 chunked upserts (305 items / 250 per chunk), not 305 individual calls', runResult.upsertCallCount === 2, runResult);
    check('Chunk sizes are 250 then 55', JSON.stringify(runResult.upsertChunkSizes) === JSON.stringify([250, 55]), runResult.upsertChunkSizes);
    check('Skipped items (cloud newer) were never included in any upsert batch', runResult.uploadedIds.indexOf('tx_0') === -1 && runResult.uploadedIds.indexOf('tx_1') === -1, runResult.uploadedIds.length);
    check('Skipped items still got _cloud_id stamped (so they don’t retry forever)', runResult.tx0CloudId === 'tx_0', runResult);
    check('Uploaded items got _cloud_id stamped', runResult.tx2CloudId === 'tx_2', runResult);
    check('Migration marked done in localStorage (no errors)', runResult.migrationDone === '1', runResult);

    // 🔍 Probe: a transient upsert failure on the first chunk should retry
    // with backoff and eventually succeed, not silently drop the batch.
    const retryResult = await page.evaluate(async () => {
      window._v2Session = { access_token: 'fake' };
      window._v2Household = { id: 'hh_mig_test2' };
      authState.status = 'authenticated';
      AppState.transactions = [{ id: 'retry_tx_1', amount: 5, date: '2026-01-01', type: 'expense', category: 'Other', _updated_at: '2026-07-01T00:00:00.000Z', _deleted: false }];
      AppState.goals = []; AppState.recurRules = []; AppState.budgets = {};
      window.__mockExistingRows = [];
      window.__mockUpsertCalls = [];
      window.__mockSelectCalls = [];
      window.__mockUpsertShouldFailOnce = true;
      try { localStorage.removeItem('kevt_v2_migration_done'); } catch (e) {}
      await migrationEngine.run();
      return {
        upsertAttempts: window.__mockUpsertCalls.length,
        migrationDone: localStorage.getItem('kevt_v2_migration_done'),
        cloudId: AppState.transactions[0]._cloud_id,
      };
    });
    check('🔍 A transient batch failure retries (2 attempts: 1 fail + 1 success) rather than dropping the chunk', retryResult.upsertAttempts === 2 && retryResult.migrationDone === '1' && retryResult.cloudId === 'retry_tx_1', retryResult);

    // 🔍 Root-cause regression check ("buttons went dead / can't log in"):
    // migrationEngine.run() is fire-and-forget from authSignIn() (only
    // .catch(dbg), never awaited by the UI). Before the fix, any unexpected
    // throw partway through run() — after _showStatus() opened the
    // full-screen #migration-status overlay and called enableScrollLock()
    // — skipped straight past the _hideStatus() call at the end, leaving
    // that overlay (z-index 10500, no close button) stuck open forever,
    // blocking every click in the app including the login form behind it.
    // Simulate an unexpected hard throw (not a normal {error} response
    // shape) from the existing-rows fetch and confirm the overlay and
    // scroll lock always release.
    const crashResult = await page.evaluate(async () => {
      window._v2Session = { access_token: 'fake' };
      window._v2Household = { id: 'hh_mig_test3' };
      authState.status = 'authenticated';
      AppState.transactions = [{ id: 'crash_tx_1', amount: 5, date: '2026-01-01', type: 'expense', category: 'Other', _updated_at: '2026-07-01T00:00:00.000Z', _deleted: false }];
      AppState.goals = []; AppState.recurRules = []; AppState.budgets = {};
      try { localStorage.removeItem('kevt_v2_migration_done'); } catch (e) {}

      // Force a hard throw deep inside run(), after _showStatus() has
      // already opened the overlay — simulates the class of bug (bad
      // response shape, quota error, etc.) that used to strand it open.
      var modalCountBefore = window._modalOpenCount;
      var origLsSaveV1 = window._lsSaveV1;
      window._lsSaveV1 = function () { throw new Error('simulated unexpected crash mid-migration'); };

      var threw = false;
      try {
        await migrationEngine.run();
      } catch (e) {
        threw = true;
      }
      window._lsSaveV1 = origLsSaveV1;

      var ov = document.getElementById('migration-status');
      return {
        threw: threw,
        overlayStillOpen: ov ? ov.classList.contains('open') : null,
        modalCountBefore: modalCountBefore,
        modalCountAfter: window._modalOpenCount,
      };
    });
    check('run() does not let an internal throw escape as an unhandled rejection', crashResult.threw === false, crashResult);
    check('🔍 The full-screen migration overlay is NOT left stuck open after an internal crash', crashResult.overlayStillOpen === false, crashResult);
    check('🔍 Scroll lock is released (net modal-open count unchanged) after an internal crash, not left stuck blocking the whole app', crashResult.modalCountAfter === crashResult.modalCountBefore, crashResult);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
