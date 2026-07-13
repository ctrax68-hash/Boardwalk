// plaid.js — Plaid Link integration, extracted from app.js.
// Owns: PlaidLinkManager (multi-bank Hosted Link connect/sync/unlink flow)
// and its onExit/onEvent handlers. Depends on globals defined in app.js
// (toast, showCfm, esc, fmt, AppState, saveTxToDB, normalizeTransactionShape,
// _v2Session, _v2Household, SUPABASE_URL, dbg) — load this file before app.js.

function handlePlaidExit(err, metadata) {
if(err) {
var msg = (err.display_message || err.error_message || 'Bank connection cancelled.');
toast('&#9888; ' + msg);
} else {
}
}
function handlePlaidError(eventName, metadata) {
if(eventName !== 'ERROR') return;
var code = (metadata && metadata.error_code)    || 'UNKNOWN';
var msg  = (metadata && metadata.error_message) || 'An unknown Plaid error occurred.';
toast('&#9888; Plaid error: ' + code);
}
var PlaidLinkManager = (function() {
// Multi-bank state: array of linked institutions
var STORAGE_KEY = 'kevt_plaid_multi';
var _banks = [];   // [{id, institution, accounts, lastSync, accessToken, cursor}]
var _error = null;

function _genId() { return 'bank_' + Date.now() + '_' + Math.floor(Math.random()*9999); }

function _saveState() {
try {
var safe = _banks.map(function(b) {
return { id:b.id, item_id:b.item_id, institution:b.institution, accounts:b.accounts, lastSync:b.lastSync };
});
localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
// Legacy single-bank key kept for backwards compat
if(_banks.length > 0) {
localStorage.setItem('kevt_plaid_state', JSON.stringify({
linked: true,
institution: _banks[0].institution,
accounts: _banks.reduce(function(a,b){ return a.concat(b.accounts); }, []),
lastSync: _banks[0].lastSync
}));
} else {
localStorage.setItem('kevt_plaid_state', JSON.stringify({ linked:false }));
}
} catch(e) {}
}
function load() {
try {
var raw = localStorage.getItem(STORAGE_KEY);
if(raw) {
var saved = JSON.parse(raw);
_banks = (saved||[]).map(function(b) {
return { id:b.id||_genId(), item_id:b.item_id||null, institution:b.institution||null,
accounts:b.accounts||[], lastSync:b.lastSync||null,
accessToken:null, cursor:null };
});
} else {
// Migrate from legacy single-bank storage
var legacy = localStorage.getItem('kevt_plaid_state');
if(legacy) {
var old = JSON.parse(legacy);
if(old && old.linked && old.institution) {
_banks = [{ id:_genId(), institution:old.institution,
accounts:old.accounts||[], lastSync:old.lastSync||null,
accessToken:null, cursor:null }];
_saveState();
}
}
}
} catch(e) {}
_renderConnectedUI();
}
// ── Real Plaid API calls via Supabase edge functions ─────────────
// ── Native app detection ────────────────────────────────────────────────
// The App Store build (not yet built at time of writing) should set
// window.__BOARDWALK_NATIVE__ = true before this script runs — e.g. by
// injecting that assignment via WKWebView's userScript / evaluateJavaScript
// before the page loads, or via a native bridge object's presence. This is
// the single switch that determines whether Plaid Link runs as a normal web
// flow (works in a real desktop/mobile Safari tab, but NOT in an installed
// PWA or plain WKWebView — Chase's OAuth App-to-App handoff has no tab to
// return to in those contexts) or as Hosted Link, opened by native code in
// an ASWebAuthenticationSession, which is what actually works for OAuth
// banks from inside a real app container. See create-plaid-link-token and
// plaid-webhook edge functions for the server-side half of this.
function _isNativeApp() {
return !!(window.__BOARDWALK_NATIVE__ === true);
}
function _fetchLinkToken() {
if(!_v2Session || !_v2Household) return Promise.reject(new Error('Not authenticated'));
return fetch(SUPABASE_URL + '/functions/v1/create-plaid-link-token', {
method: 'POST',
headers: {
'Authorization': 'Bearer ' + _v2Session.access_token,
'Content-Type':  'application/json'
},
body: JSON.stringify({ household_id: _v2Household.id, is_native_app: _isNativeApp() })
}).then(function(r) { return r.json(); }).then(function(d) {
if(d.error) throw new Error(d.error);
return d;
});
}
function _exchangeToken(publicToken, metadata) {
if(!_v2Session || !_v2Household) return Promise.reject(new Error('Not authenticated'));
return fetch(SUPABASE_URL + '/functions/v1/exchange-plaid-token', {
method: 'POST',
headers: {
'Authorization': 'Bearer ' + _v2Session.access_token,
'Content-Type':  'application/json'
},
body: JSON.stringify({
household_id: _v2Household.id,
public_token: publicToken,
institution:  metadata && metadata.institution ? metadata.institution : null
})
}).then(function(r) { return r.json(); }).then(function(d) {
if(d.error) throw new Error(d.error);
return d; // { item_id, institution_name, accounts }
});
}
function _syncTransactions(itemId, resetCursor) {
if(!_v2Session || !_v2Household) return Promise.reject(new Error('Not authenticated'));
return fetch(SUPABASE_URL + '/functions/v1/sync-plaid-transactions', {
method: 'POST',
headers: {
'Authorization': 'Bearer ' + _v2Session.access_token,
'Content-Type':  'application/json'
},
body: JSON.stringify({
household_id: _v2Household.id,
item_id:      itemId || null,
reset_cursor: !!resetCursor
})
}).then(function(r) { return r.json(); }).then(function(d) {
if(d.error) throw new Error(d.error);
return d; // { added, modified, removed, items }
});
}
// Set after clearAll() wipes cloud/local transaction data (see
// _clearAllWithCloud) so the NEXT sync ignores each item's stored Plaid
// cursor and does a full re-pull instead of an empty incremental one — a
// cursor-based sync otherwise correctly returns "nothing changed since last
// sync," which after a data clear leaves the local store empty forever even
// though the bank connection itself is fine.
var FORCE_PLAID_RESYNC_KEY = 'kevt_plaid_force_resync';
function _hasForceResync() {
try { return localStorage.getItem(FORCE_PLAID_RESYNC_KEY) === '1'; } catch(e) { return false; }
}
function _clearForceResync() {
try { localStorage.removeItem(FORCE_PLAID_RESYNC_KEY); } catch(e) {}
}
var _MOCK_INSTITUTIONS = [
{ name: 'Chase',       color: '#117ACA' },
{ name: 'Wells Fargo', color: '#D71E28' },
{ name: 'Bank of America', color: '#E31837' },
{ name: 'Citi Bank',   color: '#056DAE' },
{ name: 'US Bank',     color: '#1B3A6B' }
];
function _mockFetchAccounts(institutionHint) {
return new Promise(function(resolve) {
setTimeout(function() {
var inst = _MOCK_INSTITUTIONS[Math.floor(Math.random()*_MOCK_INSTITUTIONS.length)];
var suffix1 = String(1000+Math.floor(Math.random()*9000));
var suffix2 = String(1000+Math.floor(Math.random()*9000));
var bankId = 'acct_' + Date.now();
resolve({
accounts: [
{ account_id: bankId+'_chk', name: 'Checking \u2022\u2022'+suffix1,
official_name: inst.name.toUpperCase()+' CHECKING', type:'depository', subtype:'checking',
mask:suffix1, balances:{ available:Math.floor(Math.random()*8000)+500,
current:Math.floor(Math.random()*8000)+500, limit:null, iso_currency_code:'USD' } },
{ account_id: bankId+'_sav', name: 'Savings \u2022\u2022'+suffix2,
official_name: inst.name.toUpperCase()+' SAVINGS', type:'depository', subtype:'savings',
mask:suffix2, balances:{ available:Math.floor(Math.random()*20000)+1000,
current:Math.floor(Math.random()*20000)+1000, limit:null, iso_currency_code:'USD' } }
],
institution: { name: inst.name, logo: null }
});
}, 350);
});
}
function _mockFetchTransactions(bankId) {
return new Promise(function(resolve) {
var today = getTodayStr();
resolve({ transactions: [
{ transaction_id:'ptx_'+Date.now()+'_1', account_id:bankId+'_chk', date:today,
name:'Mock Coffee Co', amount:4.75, category:['Food and Drink','Coffee Shop'], pending:false },
{ transaction_id:'ptx_'+Date.now()+'_2', account_id:bankId+'_chk', date:today,
name:'Mock Grocery Store', amount:87.32, category:['Shops','Groceries'], pending:false }
]});
});
}
function _mapPlaidCategory(plaidCats) {
if(!plaidCats || !plaidCats.length) return 'Other';
var top = (plaidCats[0]||'').toLowerCase();
var sub = (plaidCats[1]||'').toLowerCase();
if(top==='food and drink')       return 'Food & Dining';
if(top==='shops')                return sub==='groceries' ? 'Food & Dining' : 'Shopping';
if(top==='travel' && sub==='gas stations') return 'Auto & Gas';
if(top==='travel')               return 'Transport';
// Plaid's "Payment" category covers credit card/loan payments, never
// housing spend — mapping it to 'Housing' mislabeled every card payment
// as a housing expense. type is what actually excludes these from
// spending totals (see _normalizePlaidTx below); category here is just
// cosmetic, so 'Other' is a safe, always-defined fallback.
if(top==='payment')              return 'Other';
if(top==='recreation')           return 'Entertainment';
if(top==='healthcare')           return 'Health & Fitness';
if(top==='service')              return 'Subscriptions';
if(top==='transfer')             return 'Investments & Tax Accruals';
return 'Other';
}
function _isPlaidCategoryPayment(plaidCats) {
if(!plaidCats || !plaidCats.length) return false;
return (plaidCats[0]||'').toLowerCase() === 'payment';
}
function _normalizePlaidTx(plaidTxs, acctTypeById) {
acctTypeById = acctTypeById || {};
return (plaidTxs||[]).map(function(ptx) {
var merchantRaw = ptx.name || 'Unknown';
// Plaid sign convention: negative amount = money coming into the account.
// On a depository account that's a real deposit (income). On a credit
// account it's a payment toward the balance (or a purchase refund) —
// the household's own money moving, never income. Only depository/
// unknown accounts are eligible for 'income'; credit accounts get
// 'expense' (a charge) or 'payment' (anything reducing the balance).
var isCredit = acctTypeById[ptx.account_id] === 'credit';
var txType = isCredit
? (ptx.amount > 0 ? 'expense' : 'payment')
: (ptx.amount > 0 ? 'expense' : 'income');
// The sign+account-type heuristic above is not reliable enough on its
// own — a real credit card "Payment Thank You" transaction came through
// sign-classified as 'expense' and got counted as new household
// spending. Plaid's own category is a stronger, independent signal for
// "this is a balance payment, not a purchase" — let it win when the two
// disagree, on a credit account.
if(isCredit && _isPlaidCategoryPayment(ptx.category)) txType = 'payment';
return normalizeTransactionShape({
id:          'plaid_' + ptx.transaction_id,
type:        txType,
amount:      Math.abs(ptx.amount),
date:        ptx.date,
merchantRaw: merchantRaw,
category:    _mapPlaidCategory(ptx.category),
note:        ptx.pending ? 'Pending' : '',
importBatch: 'plaid_' + Date.now(),
_plaid_account_id: ptx.account_id || null
});
});
}
function open() {
toast('\U0001F3E4 Connecting to bank...');
_fetchLinkToken().then(function(r) {
if (r.hosted_link_url) {
// Hosted Link (now used for both native and web/PWA — see
// create-plaid-link-token). There is no frontend onSuccess/onExit for
// Hosted Link — Plaid delivers the result to plaid-webhook via the
// SESSION_FINISHED webhook, server-side, regardless of what happens to
// this browser tab afterward. That's what makes this survive an
// installed Home Screen PWA: iOS routes an OAuth institution's (Chase,
// etc.) redirect into a disconnected Safari tab instead of back into
// the standalone app instance, so there's no reliable in-page callback
// to hook — the server-side webhook completes the connection either
// way, and this app just needs to notice a new bank appeared next time
// it's in the foreground (see checkPendingHostedLink/onHostedLinkReturn
// below).
if (typeof window.__boardwalkOpenHostedLink === 'function') {
// Native app bridge (ASWebAuthenticationSession) — kept for a future
// native build; not used by the current web/PWA app.
window.__boardwalkOpenHostedLink(r.hosted_link_url);
return;
}
try {
localStorage.setItem('kevt_plaid_hosted_link_pending', JSON.stringify({
ts: Date.now(),
household_id: _v2Household ? _v2Household.id : null
}));
} catch(e) {}
window.location.href = r.hosted_link_url;
return;
}
// Fallback: embedded Link. Only reachable if the edge function ever
// returns no hosted_link_url. Fine for non-OAuth institutions in a plain
// browser tab; OAuth institutions from an installed PWA icon would still
// hit the dead end Hosted Link above exists to avoid.
window._loadPlaidSDK(function() {
if (!window.Plaid) { toast('\u26A0 Plaid Link not available.'); return; }
try { sessionStorage.setItem('kevt_plaid_link_token', r.link_token); } catch(e) {}
var handler = window.Plaid.create({
token:     r.link_token,
onSuccess: function(public_token, metadata) { _onSuccess(public_token, metadata); },
onExit:    function(err, metadata)          { _onExit(err, metadata); },
onEvent:   function(eventName, metadata)    { _onEvent(eventName, metadata); }
});
handler.open();
});
}).catch(function(e) {
_error = e.message || 'Failed to fetch link token';
toast('\u26A0 Could not start bank connection: ' + _error);
});
}
// ── OAuth redirect resume ────────────────────────────────────────────────
// When a user completes an OAuth institution's login (Chase, Bank of
// America, etc.), Plaid redirects the browser back to this app's root URL
// with its own query parameters appended (e.g. ?oauth_state_id=...). This
// is a full page reload, so any in-memory Link session is gone — Plaid's
// docs require re-initializing Link with the SAME link_token used
// originally, plus receivedRedirectUri set to the current URL, so Link can
// detect the OAuth state and resume exactly where the user left off.
function _isOAuthRedirectReturn() {
return window.location.search.indexOf('oauth_state_id') !== -1
|| window.location.href.indexOf('oauth_state_id') !== -1;
}
// ── Native Hosted Link return ────────────────────────────────────────────
// Called by the native wrapper's ASWebAuthenticationSession completion
// handler after the boardwalk://plaid-oauth-complete callback fires (see
// the __boardwalkOpenHostedLink bridge documented in open() above). By this
// point the actual link result has already been processed server-side by
// plaid-webhook, regardless of whether the user succeeded or cancelled —
// this function's only job is to refresh what the app displays.
function onHostedLinkReturn() {
toast('\u23F3 Checking connection status...');
// Give the SESSION_FINISHED webhook a brief window to land and process
// before refreshing — it's typically near-instant, but the webhook and
// this native return happen on independent paths and could arrive in
// either order.
setTimeout(function() {
if(!_v2Session || !_v2Household) return;
fetch(SUPABASE_URL + '/functions/v1/get-connected-banks?household_id=' + encodeURIComponent(_v2Household.id), {
headers: { 'Authorization': 'Bearer ' + _v2Session.access_token }
}).then(function(r) { return r.json(); }).then(function(d) {
if(d.error) throw new Error(d.error);
var serverBanks = d.banks || [];
var priorCount = _banks.length;
// Merge: keep any locally-tracked banks, add any the server knows about
// that we don't have locally yet (this is the one plaid-webhook just
// created server-side).
serverBanks.forEach(function(sb) {
var exists = _banks.some(function(b) { return (b.item_id && b.item_id === sb.item_id) || b.id === sb.id; });
if(!exists) {
_banks.push({
id: sb.id, item_id: sb.item_id,
institution: { name: sb.institution_name || 'Bank', logo: null },
accounts: sb.accounts || [],
lastSync: sb.updated_at || sb.created_at, accessToken: null, cursor: null
});
}
});
_saveState();
_renderConnectedUI();
if(_banks.length > priorCount) {
toast('\u2705 Bank connected!');
try { localStorage.removeItem('kevt_plaid_hosted_link_pending'); } catch(e) {}
sync().catch(function(e) { dbg('[Plaid] post-link sync error: ' + e.message); });
} else if(_banks.length === priorCount) {
dbg('[Plaid] onHostedLinkReturn: no new bank found — session may have been cancelled or webhook has not landed yet.');
}
}).catch(function(e) {
dbg('[Plaid] onHostedLinkReturn refresh error: ' + e.message);
toast('&#9888; Could not confirm connection status — check Settings to verify your bank linked.');
});
}, 1500);
}
// ── Web/PWA Hosted Link pending-check ────────────────────────────────────
// Mirrors onHostedLinkReturn above, but triggered by the app simply coming
// back to the foreground rather than a native completion callback —
// necessary because on an installed Home Screen PWA, iOS can route an OAuth
// institution's redirect into a disconnected Safari tab instead of back
// into this app instance, so there is no reliable in-page callback to hook.
// The bank link itself already completed server-side (via the
// plaid-webhook SESSION_FINISHED handler, now registered for every Hosted
// Link session, not just native ones) by the time this runs — this just
// needs to notice it.
var PENDING_HOSTED_LINK_KEY = 'kevt_plaid_hosted_link_pending';
var PENDING_HOSTED_LINK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
function _readPendingHostedLink() {
try {
var raw = localStorage.getItem(PENDING_HOSTED_LINK_KEY);
if (!raw) return null;
var parsed = JSON.parse(raw);
if (!parsed || !parsed.ts || (Date.now() - parsed.ts) > PENDING_HOSTED_LINK_MAX_AGE_MS) {
localStorage.removeItem(PENDING_HOSTED_LINK_KEY);
return null;
}
return parsed;
} catch(e) { return null; }
}
function checkPendingHostedLink() {
var pending = _readPendingHostedLink();
if (!pending || !_v2Session || !_v2Household) return;
onHostedLinkReturn();
}
function _resumeOAuthIfNeeded() {
if (!_isOAuthRedirectReturn()) return;
var savedToken = null;
try { savedToken = sessionStorage.getItem('kevt_plaid_link_token'); } catch(e) {}
if (!savedToken) {
dbg('[Plaid OAuth] Detected OAuth return but no saved link_token — cannot resume.');
toast('\u26A0 Bank connection session expired. Please try connecting again.');
return;
}
toast('\u23F3 Finishing bank connection...');
_resumeOAuthWithSDK(savedToken, 0);
}
// window._loadPlaidSDK is defined in a later <script> block than the boot
// sequence that calls this on page load — on an OAuth-redirect-return load
// specifically, it's possible this runs before that later script has
// executed. Retry briefly rather than calling an undefined function
// directly, which would throw and be silently swallowed by the boot
// sequence's try/catch (producing exactly a blank screen with no visible
// error — nothing here, no toast, nothing).
function _resumeOAuthWithSDK(savedToken, attempt) {
if (typeof window._loadPlaidSDK !== 'function') {
if (attempt >= 20) {
dbg('[Plaid OAuth] _loadPlaidSDK never became available after 20 retries.');
toast('\u26A0 Could not finish bank connection — please reload and try again.');
return;
}
setTimeout(function(){ _resumeOAuthWithSDK(savedToken, attempt + 1); }, 100);
return;
}
window._loadPlaidSDK(function() {
if (!window.Plaid) { toast('\u26A0 Plaid Link not available.'); return; }
try {
var handler = window.Plaid.create({
token:               savedToken,
receivedRedirectUri: window.location.href,
onSuccess: function(public_token, metadata) {
try { sessionStorage.removeItem('kevt_plaid_link_token'); } catch(e) {}
_onSuccess(public_token, metadata);
},
onExit:    function(err, metadata) {
try { sessionStorage.removeItem('kevt_plaid_link_token'); } catch(e) {}
_onExit(err, metadata);
},
onEvent:   function(eventName, metadata)    { _onEvent(eventName, metadata); }
});
handler.open();
} catch(createErr) {
dbg('[Plaid OAuth] Plaid.create/open threw: ' + createErr.message);
toast('\u26A0 Could not finish bank connection: ' + createErr.message);
}
});
}
function _onSuccess(publicToken, metadata) {
toast('\u23F3 Verifying connection...');
_exchangeToken(publicToken, metadata).then(function(r) {
// r = { item_id, institution_name, accounts }
var bankId = _genId();
var newBank = {
id:          bankId,
item_id:     r.item_id,
institution: { name: r.institution_name || 'Bank', logo: null },
accounts:    r.accounts || [],
lastSync:    new Date().toISOString(),
accessToken: null, // never stored client-side
cursor:      null
};
_banks.push(newBank);
_saveState();
toast('\u2705 ' + (r.institution_name||'Bank') + ' connected!');
_renderConnectedUI();
// Immediately do first sync
_syncTransactions(r.item_id).then(function(syncResult) {
_processSync(bankId, syncResult);
}).catch(function(e) { dbg('[Plaid] initial sync error: ' + e.message); });
}).catch(function(e) {
_error = e.message || 'Connection failed';
toast('\u26A0 Bank connection failed: ' + _error);
});
}
function _onExit(err, metadata) {
_error = (err && (err.display_message || err.error_message)) || null;
if(typeof handlePlaidExit === 'function') handlePlaidExit(err, metadata);
}
function _onEvent(eventName, metadata) {
if(eventName === 'ERROR') {
_error = (metadata && metadata.error_message) || 'Plaid event error';
if(typeof handlePlaidError === 'function') handlePlaidError(eventName, metadata);
}
}
function _processSync(bankId, syncResult) {
var bank = null;
for(var i=0; i<_banks.length; i++) { if(_banks[i].id === bankId) { bank = _banks[i]; break; } }
if(!bank || !syncResult) return;
// Pick up refreshed account list / institution name for this bank, if the
// sync response included one — sync-plaid-transactions refreshes these on
// every call, which is what lets a bank connected before accounts/name
// were being fetched self-heal without a reconnect.
if(Array.isArray(syncResult.items)) {
var matchedItem = syncResult.items.filter(function(it){ return it.item_id === bank.item_id; })[0];
// Banks created before item_id tracking existed have no item_id to match
// on. For the common single-bank case that's unambiguous — adopt the
// lone returned item outright, which backfills item_id going forward too.
if(!matchedItem && !bank.item_id && _banks.length === 1 && syncResult.items.length === 1) {
matchedItem = syncResult.items[0];
bank.item_id = matchedItem.item_id;
}
if(matchedItem) {
if(Array.isArray(matchedItem.accounts) && matchedItem.accounts.length) bank.accounts = matchedItem.accounts;
if(matchedItem.institution_name) bank.institution = { name: matchedItem.institution_name, logo: (bank.institution && bank.institution.logo) || null };
}
}
var added = 0;
var acctTypeById = {};
(bank.accounts || []).forEach(function(a) {
if(!a || !a.account_id) return;
var t = String(a.type||'').toLowerCase();
var st = String(a.subtype||'').toLowerCase();
var isCredit = t === 'credit' || st.indexOf('credit') > -1;
acctTypeById[a.account_id] = isCredit ? 'credit' : (t || 'depository');
});
var normalized = _normalizePlaidTx(syncResult.added || [], acctTypeById);
normalized.forEach(function(tx) {
var exists = AppState.transactions.some(function(t){ return t.id === tx.id; });
if(!exists) { AppState.transactions.unshift(tx); saveTxToDB(tx); added++; }
});
// Handle modified
var modNormalized = _normalizePlaidTx(syncResult.modified || [], acctTypeById);
modNormalized.forEach(function(tx) {
var idx = AppState.transactions.findIndex(function(t){ return t.id === tx.id; });
if(idx >= 0) { AppState.transactions[idx] = tx; saveTxToDB(tx); }
});
// Handle removed
(syncResult.removed || []).forEach(function(plaidId) {
var fullId = 'plaid_' + plaidId;
AppState.transactions = AppState.transactions.filter(function(t){ return t.id !== fullId; });
});
// Update cursor from sync result
if(syncResult.items) {
syncResult.items.forEach(function(item) {
for(var i=0; i<_banks.length; i++) {
if(_banks[i].item_id === item.item_id) {
_banks[i].cursor = item.next_cursor;
_banks[i].lastSync = new Date().toISOString();
}
}
});
} else {
bank.lastSync = new Date().toISOString();
}
_saveState();
invalidateAllCaches();
lsSave();
renderAll();
return added;
}
function syncBank(bankId) {
var bank = null;
for(var i=0; i<_banks.length; i++) { if(_banks[i].id === bankId) { bank = _banks[i]; break; } }
if(!bank) { toast('Bank not found.'); return; }
var forceResync = _hasForceResync();
toast('\u21BA Syncing ' + ((bank.institution&&bank.institution.name)||'bank') + '...');
_syncTransactions(bank.item_id || null, forceResync).then(function(syncResult) {
var added = _processSync(bankId, syncResult);
if(forceResync) _clearForceResync();
toast('\u21BA Synced ' + ((bank.institution&&bank.institution.name)||'bank') + ' \u2014 ' + (added||0) + ' new transaction' + (added===1?'':'s') + '.');
_renderConnectedUI();
}).catch(function(e) {
toast('\u26A0 Sync failed: ' + e.message);
});
}
function forceResyncBank(bankId) {
var bank = null;
for(var i=0; i<_banks.length; i++) { if(_banks[i].id === bankId) { bank = _banks[i]; break; } }
if(!bank) { toast('Bank not found.'); return; }
var name = (bank.institution && bank.institution.name) || 'this bank';
showCfm('Re-import full transaction history for ' + name + '? This re-checks everything Plaid has on file for this account — it will not create duplicates of transactions already imported.', 'Force Resync', function(){
toast('↺ Re-syncing full history for ' + name + '...');
_syncTransactions(bank.item_id || null, true).then(function(syncResult) {
var added = _processSync(bankId, syncResult);
toast('↺ Resynced ' + name + ' — ' + (added||0) + ' transaction' + (added===1?'':'s') + ' imported.');
_renderConnectedUI();
}).catch(function(e) {
toast('⚠ Resync failed: ' + e.message);
});
});
}
function sync() {
if(_banks.length === 0) { toast('No bank connected.'); return Promise.resolve({ added: 0 }); }
var forceResync = _hasForceResync();
toast('\u21BA Syncing all accounts...');
return _syncTransactions(null, forceResync).then(function(syncResult) {
var totalAdded = 0;
_banks.forEach(function(bank) {
var added = _processSync(bank.id, syncResult);
totalAdded += (added||0);
});
if(forceResync) _clearForceResync();
toast('\u21BA Sync complete \u2014 ' + totalAdded + ' new transaction' + (totalAdded===1?'':'s') + '.');
_renderConnectedUI();
return { added: totalAdded };
}).catch(function(e) {
toast('\u26A0 Sync failed: ' + e.message);
throw e;
});
}

function disconnect() {
_banks = [];
_saveState();
toast('All banks disconnected.');
_renderConnectedUI();
}
function disconnectBank(bankId) {
var idx = -1;
for(var i=0; i<_banks.length; i++) { if(_banks[i].id === bankId) { idx = i; break; } }
if(idx === -1) { toast('Bank not found.'); return; }
var name = (_banks[idx].institution && _banks[idx].institution.name) || 'Bank';
var itemId = _banks[idx].item_id;
function removeLocally() {
_banks.splice(idx, 1);
_saveState();
_renderConnectedUI();
}
if(!itemId || !_v2Session || !_v2Household) {
// No server-side record to revoke (legacy/local-only bank) — just remove.
removeLocally();
toast(name + ' disconnected.');
return;
}
toast('⏳ Disconnecting ' + name + '...');
fetch(SUPABASE_URL + '/functions/v1/unlink-plaid-item', {
method: 'POST',
headers: {
'Authorization': 'Bearer ' + _v2Session.access_token,
'Content-Type':  'application/json'
},
body: JSON.stringify({ household_id: _v2Household.id, item_id: itemId })
}).then(function(r) { return r.json(); }).then(function(d) {
if(d.error) throw new Error(d.error);
removeLocally();
toast(name + ' disconnected.');
}).catch(function(e) {
// Server-side revoke failed — remove locally anyway so the user isn't
// stuck, but be honest that the underlying connection may still be live.
removeLocally();
toast('⚠ ' + name + ' removed here, but the server-side disconnect failed (' + e.message + '). It may still show as connected if you reconnect the same bank.');
});
}
function _renderConnectedUI() {
var card = document.getElementById('plaid-status-card');
if(!card) return;
if(_banks.length > 0) {
var banksHtml = _banks.map(function(bank) {
var acctRows = bank.accounts.map(function(a) {
return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border2);font-size:12px;">'
+'<span style="color:var(--sub)">'+esc(a.name)+'</span>'
+'<span style="font-weight:700;color:var(--em)">'+fmt(a.balances.current)+'</span>'
+'</div>';
}).join('');
var lastSync = bank.lastSync ? bank.lastSync.slice(0,16).replace('T',' ') : 'Never';
return '<div style="background:var(--card2);border-radius:10px;padding:10px 12px;margin-bottom:8px;border:1px solid var(--border);">'
+'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
+'<span style="font-size:13px;font-weight:700;color:var(--em)">\u2705 '+esc(bank.institution&&bank.institution.name||'Bank')+'</span>'
+'<div style="display:flex;gap:6px;">'
+'<button onclick="PlaidLinkManager.syncBank(\''+bank.id+'\')" style="background:rgba(126,200,227,0.18);border:1.5px solid rgba(0,48,73,0.12);border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;color:#003049;font-family:inherit;" aria-label="Sync this bank">\u21BA Sync</button>'
+'<button onclick="PlaidLinkManager.disconnectBank(\''+bank.id+'\')" style="background:rgba(239,68,68,.1);border:none;border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;color:#dc2626;font-family:inherit;" aria-label="Disconnect this bank">Unlink</button>'
+'</div>'
+'</div>'
+acctRows
+'<div style="display:flex;align-items:center;justify-content:space-between;margin-top:5px;">'
+'<span style="font-size:10px;color:var(--sub);">Last sync: '+lastSync+'</span>'
+'<span onclick="PlaidLinkManager.forceResyncBank(\''+bank.id+'\')" style="font-size:10px;color:var(--sub);text-decoration:underline;cursor:pointer;" role="button" tabindex="0" aria-label="Force full transaction history resync for this bank" title="Re-pull full transaction history from this bank">Force full resync</span>'
+'</div>'
+'</div>';
}).join('');
card.innerHTML =
'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">'
+'<span style="font-size:13px;font-weight:700;color:var(--text)">Connected Banks</span>'
+'<button onclick="PlaidLinkManager.open()" style="background:rgba(126,200,227,0.18);border:1.5px solid rgba(0,48,73,0.12);border-radius:8px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;color:#003049;font-family:inherit;" aria-label="Add another bank">+ Add Bank</button>'
+'</div>'
+banksHtml
+'<button onclick="PlaidLinkManager.sync()" style="width:100%;background:#7EC8E3;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;color:#003049;margin-top:4px;font-family:inherit;" aria-label="Sync all banks">\u21BA Sync All Banks</button>';
} else {
card.innerHTML =
'<div style="text-align:center;">'
+'<div style="font-size:28px;margin-bottom:8px;">🏤</div>'
+'<div style="font-size:14px;font-weight:700;margin-bottom:4px;color:var(--text);">Connect Your Bank</div>'
+'<div style="font-size:12px;color:var(--sub);margin-bottom:12px;">Auto-import transactions from one or more banks</div>'
+'<button onclick="PlaidLinkManager.open()" style="background:#7EC8E3;border:none;border-radius:12px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;color:#003049;touch-action:manipulation;font-family:inherit;" aria-label="Connect bank account">🏤 Connect Bank</button>'
+'</div>';
}
}
return {
open:           open,
sync:           sync,
syncBank:       syncBank,
forceResyncBank: forceResyncBank,
disconnect:     disconnect,
disconnectBank: disconnectBank,
load:           load,
_fetchLinkToken: _fetchLinkToken,
getState:       function(){ return { linked:_banks.length>0, banks:_banks, institution:_banks.length>0?_banks[0].institution:null, accounts:_banks.reduce(function(a,b){return a.concat(b.accounts);},[])}; },
onExit:         _onExit,
onEvent:        _onEvent,
accountSync:   function(){ return sync(); },
resumeOAuthIfNeeded: _resumeOAuthIfNeeded,
onHostedLinkReturn: onHostedLinkReturn,
checkPendingHostedLink: checkPendingHostedLink
};
})();
// Re-check for a completed Hosted Link connection whenever the app comes
// back to the foreground — covers the case where an installed Home Screen
// PWA had an OAuth bank redirect land in a disconnected Safari tab instead
// of back here (see checkPendingHostedLink for the full explanation).
document.addEventListener('visibilitychange', function(){
if(!document.hidden) {
try { PlaidLinkManager.checkPendingHostedLink(); } catch(e) {}
}
}, false);
