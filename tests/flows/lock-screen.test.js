// Verifies the privacy lock screen: shows for an authenticated user after
// idle+backgrounding, never for guest mode, blurs the shell instantly on
// backgrounding (before the idle timeout even fires), and rejects a wrong
// password without unlocking.
const { makeChecker, newPage, gotoAndBoot } = require('../lib/harness');

async function run(baseUrl) {
  const { check, summary } = makeChecker('lock-screen');
  const { browser, page, errors } = await newPage();
  await page.addInitScript(() => { try { localStorage.setItem('kevt_tutorial_done', '1'); } catch (e) {} });

  try {
    await gotoAndBoot(page, baseUrl);

    check('App loads with no page errors', errors.filter(e => e.startsWith('PAGEERROR')).length === 0, errors);

    const markup = await page.evaluate(() => {
      var ov = document.getElementById('lock-ov');
      var shell = document.getElementById('shell');
      return {
        exists: !!ov,
        hiddenByDefault: ov ? getComputedStyle(ov).display === 'none' : false,
        shellExists: !!shell,
        functionsExist: typeof bwShowLock === 'function' && typeof bwHideLock === 'function' && typeof unlockApp === 'function' && typeof lockScreenSignOut === 'function' && typeof bwMarkActivity === 'function',
      };
    });
    check('lock-ov overlay exists in DOM', markup.exists);
    check('lock-ov hidden by default', markup.hiddenByDefault);
    check('#shell exists', markup.shellExists);
    check('lock functions defined', markup.functionsExist, markup);

    // Guest mode (no _v2User) should NOT trigger lock even after simulated idle+background
    const guestResult = await page.evaluate(() => {
      _v2GuestMode = true;
      _v2User = null;
      _lockLastActive = Date.now() - 10 * 60 * 1000; // 10 min ago
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      return { lockShown: document.getElementById('lock-ov').style.display, isShownFlag: _lockIsShown };
    });
    check('Guest mode does not show lock screen after idle+background', guestResult.lockShown !== 'flex' && guestResult.isShownFlag === false, guestResult);

    // Authenticated (non-guest) user should trigger lock after idle+background
    const authResult = await page.evaluate(() => {
      _v2GuestMode = false;
      _v2User = { id: 'test-user-id', email: 'test@example.com' };
      _localSignOutInFlight = false;
      _lockIsShown = false;
      bwApplyBlur(false);
      _lockLastActive = Date.now() - 10 * 60 * 1000; // exceeds 5 min timeout
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      var shellBlurredWhileHidden = document.getElementById('shell').classList.contains('bw-privacy-blur');
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      return {
        lockShown: document.getElementById('lock-ov').style.display,
        isShownFlag: _lockIsShown,
        emailText: document.getElementById('lock-email').textContent,
        shellBlurredWhileHidden: shellBlurredWhileHidden,
        shellBlurredNow: document.getElementById('shell').classList.contains('bw-privacy-blur'),
      };
    });
    check('Authed user: blur applied instantly on backgrounding', authResult.shellBlurredWhileHidden === true, authResult);
    check('Authed user: lock screen shown after idle+background threshold exceeded', authResult.lockShown === 'flex' && authResult.isShownFlag === true, authResult);
    check('Authed user: lock screen shows correct email', authResult.emailText === 'test@example.com', authResult);
    check('Authed user: shell still blurred while locked', authResult.shellBlurredNow === true, authResult);

    // Wrong password keeps lock shown, sets error text
    await page.fill('#lock-pass', 'wrongpassword123');
    await page.click('#lock-unlock-btn');
    await page.waitForTimeout(1500);
    const wrongPassResult = await page.evaluate(() => ({
      lockShown: document.getElementById('lock-ov').style.display,
      errText: document.getElementById('lock-err').textContent,
      isShownFlag: _lockIsShown,
    }));
    check('Wrong password keeps lock screen shown', wrongPassResult.lockShown === 'flex' && wrongPassResult.isShownFlag === true, wrongPassResult);
    check('Wrong password shows an error message', wrongPassResult.errText.length > 0, wrongPassResult);

    // Manual bwHideLock() (simulating correct unlock) clears everything
    const unlockResult = await page.evaluate(() => {
      bwHideLock();
      return {
        lockShown: document.getElementById('lock-ov').style.display,
        isShownFlag: _lockIsShown,
        shellBlurred: document.getElementById('shell').classList.contains('bw-privacy-blur'),
      };
    });
    check('bwHideLock clears overlay, flag, and blur', unlockResult.lockShown === 'none' && unlockResult.isShownFlag === false && unlockResult.shellBlurred === false, unlockResult);

    // Activity resets the idle timer
    const activityResult = await page.evaluate(() => {
      _lockLastActive = Date.now() - 10 * 60 * 1000;
      bwMarkActivity();
      return (Date.now() - _lockLastActive) < 1000;
    });
    check('bwMarkActivity resets idle timer', activityResult === true);
  } finally {
    await browser.close();
  }

  return summary();
}

module.exports = { run };
