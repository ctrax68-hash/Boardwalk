// Verifies the fix for the Household/Members section in Settings
// "flashing a lot" — _hhRenderSettingsImpl() unconditionally did
// container.innerHTML = html on every call, and something (any
// renderAll() call re-renders whichever page is active, for reasons
// unrelated to household data — sync, presence heartbeats, cache
// invalidation, etc.) was calling it repeatedly. The fix memoizes the
// last-rendered HTML and skips the DOM rebuild when nothing changed.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('household-render-flash');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);
    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    const result = await page.evaluate(() => {
      // hhRenderSettings() only touches #hh-settings-section, normally
      // created as part of the Settings page template — create it
      // directly here to test the render function in isolation.
      var container = document.createElement('div');
      container.id = 'hh-settings-section';
      document.body.appendChild(container);

      window._v2User = { id: 'user_1' };
      window._v2GuestMode = false;
      window._v2Household = { id: 'hh_1', name: 'Trachsel House', owner_user_id: 'user_1' };
      window.AppState.currentUserRole = 'owner';
      window._hhMembers = [{ id: 'mem_1', user_id: 'user_1', email: 'user@example.com', role: 'owner' }];
      window._hhInvites = [];

      _hhRenderSettingsImpl();
      var firstNode = container.firstElementChild;
      var htmlAfterFirst = container.innerHTML;

      // Repeat calls with IDENTICAL data — simulating renderAll() being
      // triggered repeatedly by something unrelated (sync, presence,
      // cache invalidation) while sitting on this screen.
      _hhRenderSettingsImpl();
      _hhRenderSettingsImpl();
      _hhRenderSettingsImpl();
      var nodeAfterRepeats = container.firstElementChild;
      var htmlAfterRepeats = container.innerHTML;

      // Now an actual data change — a second member joins — should still
      // produce a real rebuild.
      window._hhMembers = [
        { id: 'mem_1', user_id: 'user_1', email: 'user@example.com', role: 'owner' },
        { id: 'mem_2', user_id: 'user_2', email: 'partner@example.com', role: 'member' },
      ];
      _hhRenderSettingsImpl();
      var nodeAfterRealChange = container.firstElementChild;
      var htmlAfterRealChange = container.innerHTML;

      document.body.removeChild(container);

      return {
        contentUnchanged: htmlAfterFirst === htmlAfterRepeats,
        sameDomNodeAcrossRepeats: firstNode === nodeAfterRepeats,
        rebuiltOnRealChange: htmlAfterRepeats !== htmlAfterRealChange,
        newDomNodeOnRealChange: nodeAfterRepeats !== nodeAfterRealChange,
        htmlAfterRealChangeMentionsSecondMember: htmlAfterRealChange.indexOf('partner@example.com') !== -1,
      };
    });
    check('Repeated calls with unchanged data produce identical HTML', result.contentUnchanged === true, result);
    check('🔍 Repeated calls with unchanged data do NOT replace the DOM node (no flash — this is the actual fix, not just matching content)', result.sameDomNodeAcrossRepeats === true, result);
    check('A real data change (member added) still produces different HTML', result.rebuiltOnRealChange === true, result);
    check('A real data change still triggers a real DOM rebuild (new node)', result.newDomNodeOnRealChange === true, result);
    check('The rebuilt content reflects the new member', result.htmlAfterRealChangeMentionsSecondMember === true, result);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
