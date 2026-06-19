/**
 * dc-connector.js — Background Dating.com connector for WordPress CRM
 *
 * Strategy
 * ────────
 * Uses a persistent Playwright browser session (real Chrome).
 * The browser logs into Dating.com with the model's credentials and navigates
 * the inbox. When Dating.com's own JavaScript fetches dialog messages from
 * api.dating.com, Playwright intercepts those authenticated responses — the
 * same approach as the manual bookmarklet, but automated.
 * Sanitized message data is then POSTed to the existing CRM dc_import_messages
 * AJAX endpoint (authenticated only by the per-model import token, not by any
 * Dating.com cookie or session header).
 *
 * Dating.com session cookies live exclusively inside the Playwright browser
 * profile (.session/). They are never sent to or stored by the CRM server.
 *
 * Run manually:   node dc-connector.js
 * Run test cycle: node dc-connector.js --test
 * See README.md for PM2 / systemd deployment.
 */

'use strict';

const { chromium } = require('playwright');
const path         = require('path');
const fs           = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────

const CFG_PATH = path.join(__dirname, 'config.js');
if (!fs.existsSync(CFG_PATH)) {
  console.error(
    '[DC Connector] config.js not found.\n' +
    '  cp connector/config.example.js connector/config.js\n' +
    '  then fill in crmUrl, modelId, importToken, dcEmail, dcPassword.'
  );
  process.exit(1);
}
const config = require(CFG_PATH);

const TEST_MODE    = process.argv.includes('--test') || !!config.testMode;
const SESSION_DIR  = path.join(__dirname, '.session');
const POLL_MS      = Math.max(config.pollIntervalMs ?? 60_000, 15_000);  // floor 15 s
const MAX_CONTACTS = TEST_MODE ? 1 : Math.min(config.maxContactsPerRun ?? 10, 50);

// ── Logging ────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function log(...a)   { console.log(`[${ts()}]`,          ...a); }
function warn(...a)  { console.warn(`[${ts()}] [WARN]`,  ...a); }
function error(...a) { console.error(`[${ts()}] [ERROR]`, ...a); }

// ── Startup validation ─────────────────────────────────────────────────────

function validateConfig() {
  const missing = ['crmUrl','modelId','importToken','dcEmail','dcPassword']
    .filter(k => !config[k]);
  if (missing.length) {
    error('config.js is missing required fields:', missing.join(', '));
    process.exit(1);
  }
}

// ── CRM API helpers ────────────────────────────────────────────────────────

/**
 * Sanitize one message object to exactly the 8 fields the CRM handler accepts.
 * Mirrors the bookmarklet's snd() sanitisation.
 */
function sanitizeMessage(m) {
  return {
    id:        +(m.id        ?? 0),
    sender:    String(m.sender    ?? ''),
    recipient: String(m.recipient ?? ''),
    timestamp: +(m.timestamp ?? 0),
    read:      m.read ? 1 : 0,
    text:      String(m.text ?? '').substring(0, 2000),
    tag:       String(m.tag    ?? ''),
    status:    String(m.status ?? ''),
  };
}

/**
 * POST messages for one dialog to the CRM dc_import_messages endpoint.
 * Uses Playwright's built-in request context so we need no extra HTTP library.
 * operator_id and contact_id must be digit-only strings (validated by CRM).
 */
async function postDialogToCRM(reqCtx, operatorId, contactId, messages) {
  const safe = messages.filter(m => m && typeof m === 'object').map(sanitizeMessage);
  if (safe.length === 0) return null;

  const resp = await reqCtx.post(`${config.crmUrl}/wp-admin/admin-ajax.php`, {
    form: {
      action:      'dc_import_messages',
      token:       String(config.importToken),
      model_id:    String(config.modelId),
      operator_id: String(operatorId),
      contact_id:  String(contactId),
      messages:    JSON.stringify(safe),
    },
    timeout: 20_000,
  });

  if (!resp.ok()) throw new Error(`CRM HTTP ${resp.status()}`);
  return resp.json();
}

/**
 * Report connector sync status to CRM (stored in post meta, shown in UI).
 * Silently ignores network errors — status reporting is best-effort.
 */
async function reportStatus(reqCtx, status, errMsg, imported) {
  try {
    await reqCtx.post(`${config.crmUrl}/wp-admin/admin-ajax.php`, {
      form: {
        action:      'dc_bg_sync_status',
        sync_action: 'update',
        token:       String(config.importToken),
        model_id:    String(config.modelId),
        status:      status,
        error:       errMsg   ?? '',
        imported:    String(imported ?? 0),
      },
      timeout: 10_000,
    });
  } catch (e) {
    warn('Could not report status to CRM:', e.message);
  }
}

// ── Browser / session helpers ──────────────────────────────────────────────

/**
 * Heuristic check for a logged-in Dating.com session.
 * Adjust selectors if Dating.com changes its markup.
 */
async function isLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      return !!(
        document.querySelector('[data-qa="user-avatar"]')   ||
        document.querySelector('[data-qa="logout"]')        ||
        document.querySelector('[href*="/logout"]')         ||
        document.querySelector('[class*="UserMenu"]')       ||
        document.querySelector('[class*="Header_user"]')    ||
        document.querySelector('[class*="TopBar_avatar"]')
      );
    });
  } catch {
    return false;
  }
}

/**
 * Attempt to log into Dating.com.
 * On success returns true. The persistent session is saved to SESSION_DIR
 * so subsequent runs skip this step unless the session expires.
 */
async function login(page) {
  log('Checking Dating.com session...');
  await page.goto('https://dating.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  if (await isLoggedIn(page)) {
    log('Session active — skipping login.');
    return true;
  }

  log('Session expired or not found — attempting login...');
  try {
    // Wait for a login form to appear
    await page.waitForSelector(
      'input[type="email"], input[name="email"], input[name="login"], [data-qa="email-input"]',
      { timeout: 15_000 }
    );

    // Fill credentials
    const emailSel = 'input[type="email"], input[name="email"], input[name="login"], [data-qa="email-input"]';
    const passSel  = 'input[type="password"], [data-qa="password-input"]';
    const btnSel   = 'button[type="submit"], input[type="submit"], [data-qa="login-btn"], [data-qa="submit-btn"]';

    await page.fill(emailSel, config.dcEmail);
    await page.fill(passSel,  config.dcPassword);
    await page.click(btnSel);

    // Give the SPA time to complete auth and redirect
    await page.waitForTimeout(5_000);

    if (await isLoggedIn(page)) {
      log('Login successful.');
      return true;
    }

    warn('Login submitted but no logged-in indicator found. ' +
         'The site may have changed its UI or require captcha completion.');
    if (!config.headless) {
      log('Browser is visible — you can complete login manually if needed. Waiting 30s...');
      await page.waitForTimeout(30_000);
      return isLoggedIn(page);
    }
    return false;
  } catch (e) {
    error('Login error:', e.message);
    return false;
  }
}

// ── Dialog selectors ───────────────────────────────────────────────────────
// Dating.com is a React SPA. These selectors cover known markup variants.
// Add more here if the site is updated.
const DIALOG_SELECTORS = [
  '[data-qa="dialog-item"]',
  '[data-qa="conversation-item"]',
  '[class*="Dialog_item"]',
  '[class*="dialog-item"]',
  '[class*="DialogItem"]',
  '[class*="ConversationItem"]',
  '[class*="ChatListItem"]',
  '.dialogItem',
];

// ── Core sync cycle ────────────────────────────────────────────────────────

async function runOneSyncCycle(page, reqCtx) {
  const intercepted = new Map(); // contactId → { operatorId, messages[] }

  // Install response interceptor before navigation
  const onResponse = async (response) => {
    const url = response.url();
    const m   = url.match(/api\.dating\.com\/dialogs\/messages\/(\d+):(\d+)/);
    if (!m || response.status() !== 200) return;
    const [, operatorId, contactId] = m;
    if (intercepted.has(contactId)) return; // already captured this dialog this cycle
    try {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        intercepted.set(contactId, { operatorId, messages: data });
        if (TEST_MODE) log(`  ↓ intercepted contact=${contactId} op=${operatorId} msgs=${data.length}`);
      }
    } catch { /* non-JSON or empty — skip */ }
  };
  page.on('response', onResponse);

  try {
    const inboxUrl = config.inboxUrl ?? 'https://dating.com/';
    log(`Navigating to inbox: ${inboxUrl}`);
    await page.goto(inboxUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Let the SPA hydrate and fire its initial dialog-list API calls
    await page.waitForTimeout(4_000);

    // Attempt to click through dialog list items so Dating.com's own JS
    // loads each conversation (triggering /dialogs/messages/ API calls)
    let clicked = 0;
    for (const sel of DIALOG_SELECTORS) {
      const items = await page.$$(sel);
      if (items.length === 0) continue;

      log(`Found ${items.length} dialog item(s) via "${sel}". Clicking up to ${MAX_CONTACTS}...`);
      const limit = Math.min(items.length, MAX_CONTACTS);
      for (let i = 0; i < limit; i++) {
        try {
          await items[i].scrollIntoViewIfNeeded({ timeout: 2_000 });
          await items[i].click({ timeout: 3_000 });
          await page.waitForTimeout(1_500); // allow API response to arrive
          clicked++;
        } catch { /* element may have been removed by SPA re-render */ }
        if (intercepted.size >= MAX_CONTACTS) break;
      }
      break; // used first matching selector
    }

    if (clicked === 0 && intercepted.size === 0) {
      warn('No dialog items found via click-through. Relying on page-load interceptions only.');
      warn('Check config.inboxUrl or try headless:false for a visual inspection.');
    }

    // Extra wait to collect any in-flight responses
    await page.waitForTimeout(3_000);

  } finally {
    page.off('response', onResponse);
  }

  if (intercepted.size === 0) {
    log('No dialogs intercepted this cycle.');
    return { imported: 0, errors: 0 };
  }

  log(`Intercepted ${intercepted.size} dialog(s). Posting to CRM...`);
  let totalImported = 0;
  let errors = 0;

  for (const [contactId, { operatorId, messages }] of intercepted) {
    try {
      const result = await postDialogToCRM(reqCtx, operatorId, contactId, messages);
      if (result?.success) {
        const n = result.data?.imported ?? 0;
        totalImported += n;
        if (TEST_MODE || n > 0) {
          log(`  ✓ contact=${contactId}  new=${n}  total=${result.data?.total_messages ?? '?'}`);
        }
      } else {
        warn(`  ✗ contact=${contactId}  CRM error: ${result?.data}`);
        errors++;
      }
    } catch (e) {
      warn(`  ✗ contact=${contactId}  POST failed: ${e.message}`);
      errors++;
    }
  }

  log(`Cycle done. New messages: ${totalImported}. Errors: ${errors}.`);
  return { imported: totalImported, errors };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  validateConfig();
  log(`DC Connector starting. TEST_MODE=${TEST_MODE}, POLL_MS=${POLL_MS}, MAX_CONTACTS=${MAX_CONTACTS}`);
  if (TEST_MODE) log('TEST MODE — one cycle only, then exit.');

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless:  config.headless ?? true,
    viewport:  { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    'en-US',
  });

  const page    = context.pages()[0] || await context.newPage();
  const reqCtx  = context.request;

  const shutdown = async () => {
    log('Shutting down...');
    await context.close().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT',  shutdown);
  process.once('SIGTERM', shutdown);

  // Initial login / session check
  if (!(await login(page))) {
    await reportStatus(reqCtx, 'error', 'Login failed on startup', 0);
    await context.close();
    process.exit(1);
  }

  // Main loop
  while (true) {
    try {
      const { imported, errors } = await runOneSyncCycle(page, reqCtx);
      await reportStatus(
        reqCtx,
        errors > 0 ? 'warning' : 'ok',
        errors > 0 ? `${errors} contact(s) had POST errors` : '',
        imported
      );
    } catch (e) {
      error('Sync cycle threw:', e.message);
      await reportStatus(reqCtx, 'error', e.message.substring(0, 300), 0);

      // Re-check session on cycle-level failure
      if (!(await isLoggedIn(page))) {
        log('Session may have expired — attempting re-login...');
        if (!(await login(page))) {
          warn('Re-login failed. Will retry next cycle.');
        }
      }
    }

    if (TEST_MODE) {
      log('TEST MODE — exiting after one cycle.');
      break;
    }

    log(`Waiting ${POLL_MS / 1000}s until next cycle...`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  await context.close().catch(() => {});
}

main().catch(e => {
  error('Fatal:', e.message);
  process.exit(1);
});
