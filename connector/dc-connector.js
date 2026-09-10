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
const MAX_CONTACTS = Math.min(config.maxContactsPerRun ?? 20, 50);

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

function shouldImportMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return false;
  }

  const type = String(m.type ?? '').trim();
  const text = String(m.text ?? '').trim();

  // Служебное событие Dating.com, а не реальное сообщение пользователя.
  if (type === 'letters.recommendations') {
    return false;
  }

  // Обычное текстовое сообщение.
  if (text !== '') {
    return true;
  }

  // Оставляем только осмысленные события с вложением или подарком.
  const attachments =
    m.meta && Array.isArray(m.meta.attachments)
      ? m.meta.attachments
      : [];

  const reference =
    m.meta && m.meta.reference
      ? String(m.meta.reference)
      : '';

  return attachments.length > 0 || reference !== '';
}

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
  const safe = messages
    .filter(shouldImportMessage)
    .map(sanitizeMessage);
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
      const text = document.body ? document.body.innerText : '';
      const app = document.querySelector('.application-container');
      const appClass = app ? String(app.className || '') : '';

      const isSignupOrBlocked =
        text.includes('Sign up to start meeting people') ||
        text.includes('Create an account with just one click') ||
        appClass.includes('registration-process') ||
        (appClass.includes('overlay-open') && text.includes('Continue with password'));

      const hasRealInbox =
        text.includes("User's ID:") &&
        (
          text.includes('My Contacts') ||
          text.includes('Chat Requests') ||
          text.includes('Follow-up Emails') ||
          document.querySelector('[data-sender]') ||
          document.querySelector('[data-recipient]') ||
          document.querySelector('.emails-item') ||
          document.querySelector('.chat-list-item')
        );

      const hasLogout =
        text.includes('Sign out') ||
        document.querySelector('[data-qa="logout"]') ||
        document.querySelector('[href*="/logout"]');

      return !isSignupOrBlocked && !!(hasRealInbox || hasLogout);
    });
  } catch {
    return false;
  }
}

async function saveLoginFailure(page, reason) {
  try {
    await page.screenshot({ path: '/tmp/dc-login-failed.png', fullPage: true });
  } catch {}

  try {
    const fs = require('fs');
    const url = page.url();
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    await fs.promises.writeFile(
      '/tmp/dc-login-failed.txt',
      `REASON=${reason}\nURL=${url}\nTITLE=${title}\n\n${body.slice(0, 8000)}`
    );
  } catch {}
}

async function clickVisibleExactText(page, labels) {
  return await page.evaluate((labels) => {
    const lower = labels.map(x => String(x).trim().toLowerCase());

    const items = Array.from(document.querySelectorAll('button, a, span, div'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return { el, r, text, low: text.toLowerCase() };
      })
      .filter(x => x.r.width > 5 && x.r.height > 5 && x.r.y >= 0 && x.r.y < 1200 && lower.includes(x.low));

    const topItem = items.find(x => x.r.y < 180) || items[0];

    if (!topItem) return false;

    topItem.el.scrollIntoView({ block: 'center', inline: 'center' });
    topItem.el.click();

    return {
      text: topItem.text,
      x: Math.round(topItem.r.x),
      y: Math.round(topItem.r.y)
    };
  }, labels);
}

async function submitPasswordForm(page) {
  // DC_LOGIN_SUBMIT_V8: click the submit control inside the actual password form.
  const password = page.locator('input[type="password"]:visible').first();
  if (!(await password.count())) return false;

  const form = password.locator('xpath=ancestor::form[1]');
  if (await form.count()) {
    const submit = form.locator('button[type="submit"]:visible, input[type="submit"]:visible');
    if (await submit.count()) {
      await submit.last().click({ timeout: 10_000 });
      return true;
    }
  }

  await password.press('Enter');
  return true;
}

async function login(page) {
  log('Checking Dating.com session...');

  try {
    await page.goto(config.inboxUrl || 'https://dating.com/en/people/#inbox', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    await page.waitForTimeout(6_000);

    if (await isLoggedIn(page)) {
      log('Session active — skipping login.');
      return true;
    }

    // DC_LOGIN_INBOX_ENTRY_V9: the live site exposes the working Sign in/password
    // flow from the inbox welcome screen. Navigating back to the root page can
    // expose a different registration overlay and the wrong off-screen form.
    log('Session expired or not found — opening login from inbox welcome screen...');
    await page.waitForTimeout(1_000);

    await clickVisibleExactText(page, ['Accept all', 'Accept All']).catch(() => {});
    await page.waitForTimeout(1_000);

    log('Opening top login form...');
    // DC_LOGIN_SWITCHER_V6: use the real Sign in control, not a nested text node.
    const clickedLogin = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('button, a'));
      const control = controls.find((el) => {
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        return text === 'sign in' || text === 'log in' || cls.includes('sign-in');
      });
      if (!control) return false;
      control.scrollIntoView({ block: 'center', inline: 'center' });
      control.click();
      return true;
    }).catch(() => false);

    if (!clickedLogin) {
      warn('Could not find top login button.');
    }

    await page.waitForTimeout(3_000);

    log('Switching to password login if needed...');
    // DC_LOGIN_PASSWORD_SWITCH_V8: use the exact interactive text proven in live UI.
    const passwordSwitch = page.getByText('Continue with password', { exact: true });
    if (await passwordSwitch.count()) {
      await passwordSwitch.first().click({ timeout: 10_000 });
    } else {
      await clickVisibleExactText(page, ['Continue with password']);
    }
    await page.waitForTimeout(3_000);

    const emailSel = 'input[type="email"]:visible, input[name="email"]:visible, input[name="login"]:visible, [data-qa="email-input"]:visible';
    const passSel = 'input[type="password"]:visible, [data-qa="password-input"]:visible';

    log('Filling email...');
    await page.locator(emailSel).first().fill(config.dcEmail, { timeout: 20_000 });

    let passCount = await page.locator(passSel).count();

    if (passCount === 0) {
      log('Submitting email step...');
      await clickVisibleExactText(page, ['Continue']).catch(() => {});
      await page.waitForTimeout(5_000);
    }

    log('Filling password...');
    await page.locator(passSel).first().fill(config.dcPassword, { timeout: 20_000 });

    log('Submitting password form...');
    await submitPasswordForm(page);

    await page.waitForTimeout(15_000);

    await page.goto(config.inboxUrl || 'https://dating.com/en/people/#inbox', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    await page.waitForTimeout(10_000);

    if (await isLoggedIn(page)) {
      log('Login successful.');
      return true;
    }

    warn('Login submitted but still not logged in. Saved screenshot/text.');
    await saveLoginFailure(page, 'not_logged_in_after_submit');
    return false;
  } catch (e) {
    error('Login error:', e.message);
    await saveLoginFailure(page, 'login_error_' + e.message);
    return false;
  }
}

// ── Dialog selectors ───────────────────────────────────────────────────────
// Dating.com is a React SPA. These selectors cover known markup variants.
// Add more here if the site is updated.
const DIALOG_SELECTORS = [
  'li.emails-item[data-sender]',
  '.emails-item[data-sender]',
  'ul.emails > li[data-sender]',
  '[data-sender]',
  '.chat-list-item',
  '.contacts-chat-list-wrapper .chat-list-item',
];

// ── Core sync cycle ────────────────────────────────────────────────────────

async function crmOutboxPost(reqCtx, action, fields = {}) {
  const response = await reqCtx.post(`${config.crmUrl}/wp-admin/admin-ajax.php`, {
    form: {
      action,
      token: String(config.importToken),
      model_id: String(config.modelId),
      ...fields,
    },
    timeout: 20_000,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`CRM ${action} returned HTTP ${response.status()} with invalid JSON`);
  }

  if (!response.ok() || !payload?.success) {
    throw new Error(String(payload?.data || `CRM ${action} HTTP ${response.status()}`));
  }

  return payload.data;
}

async function finishOutgoingQueueItem(reqCtx, queueId, status, datingStatus = 0, errorText = '') {
  return crmOutboxPost(reqCtx, 'dc_outbox_result', {
    queue_id: String(queueId),
    status: String(status),
    dating_status: String(datingStatus || 0),
    error: String(errorText || '').substring(0, 1000),
  });
}

async function processOutgoingQueue(page, reqCtx) {
  let pulled;

  try {
    pulled = await crmOutboxPost(reqCtx, 'dc_outbox_pull');
  } catch (e) {
    warn('Outbox pull failed:', e.message);
    return { processed: 0, errors: 1 };
  }

  const item = pulled?.item;
  if (!item) return { processed: 0, errors: 0 };

  const queueId = String(item.id || '');
  const contactId = String(item.contact_id || '').replace(/\D+/g, '');
  const operatorId = String(config.operatorId || item.operator_id || '').replace(/\D+/g, '');
  const text = String(item.text || '').trim().substring(0, 2000);

  if (!queueId || !operatorId || !contactId || !text) {
    const reason = 'Invalid outgoing queue item: missing id/operator/contact/text';
    await finishOutgoingQueueItem(reqCtx, queueId || '0', 'error', 0, reason).catch(() => {});
    warn(reason);
    return { processed: 0, errors: 1 };
  }

  let apiHeaders = {};

  const captureAuth = (request) => {
    const url = request.url();
    const headers = request.headers();

    if (url.includes('api.dating.com/') && headers.authorization) {
      apiHeaders = {
        accept: headers.accept || 'application/json',
        authorization: headers.authorization,
        'x-client': headers['x-client'] || 'dating-web',
      };

      for (const name of [
        'x-client-instance',
        'x-client-version',
        'content-language',
        'accept-language',
      ]) {
        if (headers[name]) apiHeaders[name] = headers[name];
      }
    }
  };

  page.on('request', captureAuth);

  try {
    await page.goto(config.inboxUrl || 'https://dating.com/en/people/#inbox', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    await page.waitForTimeout(5_000);

    if (!apiHeaders.authorization) {
      const contact = page.locator(
        `[data-user-id="${contactId}"], ` +
        `[data-sender="${contactId}"], ` +
        `[data-recipient="${contactId}"]`
      ).first();

      if (await contact.count()) {
        await contact.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
      }
    }
  } finally {
    page.off('request', captureAuth);
  }

  if (!apiHeaders.authorization) {
    const reason = 'Dating.com authorization header was not captured';
    await finishOutgoingQueueItem(reqCtx, queueId, 'error', 0, reason).catch(() => {});
    warn(`Outbox #${queueId}: ${reason}`);
    return { processed: 0, errors: 1 };
  }

  let result;

  try {
    result = await page.evaluate(
      async ({ operatorId, contactId, text, apiHeaders }) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        const headers = {
          accept: apiHeaders.accept || 'application/json',
          'content-type': 'application/json',
          authorization: apiHeaders.authorization,
          'x-client': apiHeaders['x-client'] || 'dating-web',
        };

        for (const name of [
          'x-client-instance',
          'x-client-version',
          'content-language',
          'accept-language',
        ]) {
          if (apiHeaders[name]) headers[name] = apiHeaders[name];
        }

        const readJson = async (response) => {
          try {
            return await response.json();
          } catch {
            return null;
          }
        };

        const findObjects = (value, out = []) => {
          if (!value) return out;

          if (Array.isArray(value)) {
            for (const item of value) findObjects(item, out);
            return out;
          }

          if (typeof value === 'object') {
            out.push(value);
            for (const nested of Object.values(value)) {
              findObjects(nested, out);
            }
          }

          return out;
        };

        // DC_DIALOG_HISTORY_MERGE_V42
        const getDialogMessages = async () => {
          const urls = [
            `https://api.dating.com/dialogs/messages/${operatorId}:${contactId}?omit=0&select=80`,
            `https://api.dating.com/dialogs/messages/${contactId}:${operatorId}?omit=0&select=80`,
          ];

          const collected = [];

          for (const url of urls) {
            try {
              const response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers,
              });

              if (!response.ok) {
                continue;
              }

              const data =
                await readJson(response);

              const objects =
                findObjects(data).filter(item => (
                  item &&
                  typeof item === 'object' &&
                  ('sender' in item || 'recipient' in item) &&
                  ('text' in item || 'message' in item)
                ));

              collected.push(...objects);
            } catch (_) {
              // One orientation may temporarily lag/fail.
              // Continue with the other read-only representation.
            }
          }

          const unique = new Map();

          for (const message of collected) {
            const normalizedMessageText =
              String(
                message.text ||
                message.message ||
                ''
              )
                .replace(/\s+/g, ' ')
                .trim();

            const key = [
              String(message.id || ''),
              String(message.tag || ''),
              String(message.sender || ''),
              String(message.recipient || ''),
              String(message.timestamp || ''),
              normalizedMessageText,
            ].join('|');

            if (!unique.has(key)) {
              unique.set(key, message);
            }
          }

          return [...unique.values()];
        };

        const normalizeText = (value) =>
          String(value || '').replace(/\s+/g, ' ').trim();

        const textMatches = (messageText) => {
          const expected = normalizeText(text);
          const actual = normalizeText(messageText);

          return (
            actual === expected ||
            actual.includes(expected.substring(0, Math.min(expected.length, 120)))
          );
        };

        const findConfirmedOutgoing = (messages, tag) =>
          messages.find(message => (
            String(message.sender || '') === operatorId &&
            (
              (tag && String(message.tag || '') === String(tag)) ||
              textMatches(message.text || message.message || '')
            )
          ));

        const collectResponseHeaders = (response) => {
          const result = {};
          for (const name of [
            'x-stage',
            'x-reason',
            'x-comment',
            'response-id',
            'x-original-message-id',
          ]) {
            const value = response.headers.get(name);
            if (value) result[name] = value;
          }
          return result;
        };

        // DC_CHAT_ELIGIBILITY_V2
        //
        // Dating.com may expose Letters, winks and service events in the
        // same dialog/message surfaces as normal Chat. Determine the
        // usable outbound channel BEFORE sending anything.

        const before = await getDialogMessages();

        const sortedBefore = [...before]
          .sort(
            (a, b) =>
              Number(b.timestamp || 0) -
              Number(a.timestamp || 0)
          );

        const getMeta = (message) => (
          message &&
          message.meta &&
          typeof message.meta === 'object'
            ? message.meta
            : {}
        );

        const isLetterBacked = (message) => {
          const meta = getMeta(message);

          return Boolean(
            meta.letter ||
            meta.introductory === true
          );
        };

        const isSystemLike = (message) => {
          if (!message || typeof message !== 'object') {
            return true;
          }

          const meta = getMeta(message);

          if (
            meta.wink === true ||
            meta.interactive
          ) {
            return true;
          }

          const value = normalizeText(
            message.text ||
            message.message ||
            ''
          ).toLowerCase();

          if (!value) {
            return true;
          }

          const servicePatterns = [
            'liked your profile',
            'likes your profile',
            'ready to chat',
            'is ready to chat',
            'exploring your profile',
            'is exploring your profile',
            'sent you a wink',
            'wants to chat',
          ];

          return servicePatterns.some(
            pattern => value.includes(pattern)
          );
        };

        let latestIncomingLetter = sortedBefore.find(
          message => (
            String(message.sender || '') === contactId &&
            isLetterBacked(message)
          )
        );

        // Some Dating.com responses do not expose meta.letter in the
        // message-history representation. In that case, check the actual
        // Letter history before deciding the channel.
        if (!latestIncomingLetter) {
          try {
            const lettersResponse = await fetch(
              `https://api.dating.com/dialogs/letters/${operatorId}` +
              `?omit=0&participant=${contactId}&select=20`,
              {
                method: 'GET',
                credentials: 'include',
                headers,
              }
            );

            if (lettersResponse.ok) {
              const lettersData =
                await readJson(lettersResponse);

              const inboundLetters =
                findObjects(lettersData)
                  .filter(letter => (
                    letter &&
                    String(letter.sender || '') === contactId &&
                    String(letter.recipient || '') === operatorId &&
                    (
                      letter.id ||
                      letter.text ||
                      letter.message
                    )
                  ))
                  .sort(
                    (a, b) =>
                      Number(b.timestamp || 0) -
                      Number(a.timestamp || 0)
                  );

              if (inboundLetters.length > 0) {
                const letter = inboundLetters[0];

                latestIncomingLetter = {
                  ...letter,
                  meta: {
                    ...(letter.meta || {}),
                    letter:
                      letter.id ||
                      (letter.meta && letter.meta.letter),
                    cover:
                      letter.cover ||
                      (
                        letter.meta &&
                        letter.meta.cover
                      ),
                  },
                };
              }
            }
          } catch (_) {
            // Read-only Letter lookup is an additional classifier signal.
            // If unavailable, continue with the message-history evidence.
          }
        }

        const latestIncomingChat =
          sortedBefore.find(message => (
            String(message.sender || '') === contactId &&
            !isLetterBacked(message) &&
            !isSystemLike(message)
          ));

        const latestOutgoingChat =
          sortedBefore.find(message => (
            String(message.sender || '') === operatorId &&
            String(message.recipient || '') === contactId &&
            !isLetterBacked(message) &&
            !isSystemLike(message)
          ));

        const chatEvidence = [
          latestIncomingChat,
          latestOutgoingChat,
        ]
          .filter(Boolean)
          .sort(
            (a, b) =>
              Number(b.timestamp || 0) -
              Number(a.timestamp || 0)
          )[0] || null;

        // DC_CHANNEL_CLASSIFIER_V5
        //
        // The newest actionable inbound message in the current dialog
        // is authoritative. Historical Letter records must not override
        // a newer normal Chat.
        //
        // A real Letter may lose meta.letter in dialog history, therefore
        // compare the newest inbound item against Letter history by ID/text.

        const latestIncomingActionable =
          sortedBefore.find(message => (
            String(message.sender || '') === contactId &&
            !isSystemLike(message)
          )) || null;

        const actionableText = normalizeText(
          String(
            latestIncomingActionable &&
            (
              latestIncomingActionable.text ||
              latestIncomingActionable.message
            ) ||
            ''
          )
        );

        const letterText = normalizeText(
          String(
            latestIncomingLetter &&
            (
              latestIncomingLetter.text ||
              latestIncomingLetter.message
            ) ||
            ''
          )
        );

        const actionableId = String(
          latestIncomingActionable &&
          (
            latestIncomingActionable.id ||
            latestIncomingActionable.messageId ||
            latestIncomingActionable.message_id
          ) ||
          ''
        );

        const letterId = String(
          latestIncomingLetter &&
          (
            latestIncomingLetter.id ||
            latestIncomingLetter.messageId ||
            latestIncomingLetter.message_id
          ) ||
          ''
        );

        const actionableMatchesLetter = !!(
          latestIncomingActionable &&
          latestIncomingLetter &&
          (
            isLetterBacked(latestIncomingActionable) ||
            (
              actionableId &&
              letterId &&
              actionableId === letterId
            ) ||
            (
              actionableText &&
              letterText &&
              actionableText === letterText
            )
          )
        );

        let outboundChannel = 'blocked';

        if (latestIncomingActionable) {
          outboundChannel =
            actionableMatchesLetter
              ? 'letter'
              : 'chat';
        } else if (latestIncomingLetter) {
          outboundChannel = 'letter';
        } else if (latestOutgoingChat) {
          outboundChannel = 'chat';
        }

        // Do not call the Node-side logger inside page.evaluate().
        // Browser-context code cannot access outer-scope functions.

        if (outboundChannel === 'blocked') {
          return {
            ok: false,
            confirmed: false,
            channel: 'chat-not-active',
            status: 0,
            body:
              'Dating.com пока не разрешает обычный ответ этому контакту. ' +
              'Сейчас в диалоге есть только системное событие/приветствие ' +
              'или Chat ещё не активирован. Дождитесь обычного сообщения ' +
              'или проверьте доступное действие непосредственно в Dating.com.',
            tag: '',
            responseHeaders: {},
          };
        }

        if (outboundChannel === 'chat') {
          const randomPart =
            String(
              Math.floor(Math.random() * 10_000)
            ).padStart(4, '0');

          const chatTag =
            Number(
              `${Date.now()}${randomPart}`
            );

          const chatResponse = await fetch(
            `https://api.dating.com/dialogs/messages/${operatorId}:${contactId}`,
            {
              method: 'POST',
              credentials: 'include',
              headers,
              body: JSON.stringify({
                tag: chatTag,
                text,
              }),
            }
          );

          const chatBody =
            await chatResponse
              .text()
              .catch(() => '');

          const chatHeaders =
            collectResponseHeaders(
              chatResponse
            );

          // DC_CHAT_CONFIRM_POLL_V42
          // HTTP 202 is asynchronous. Never repeat the POST here.
          // Poll read-only history only.
          let confirmedChat = null;

          for (const delay of [
            2_000,
            4_000,
            8_000,
            12_000,
          ]) {
            await sleep(delay);

            const afterChat =
              await getDialogMessages();

            confirmedChat =
              findConfirmedOutgoing(
                afterChat,
                chatTag
              );

            if (confirmedChat) {
              break;
            }
          }

          if (confirmedChat) {
            return {
              ok: true,
              confirmed: true,
              channel: 'chat',
              status: chatResponse.status,
              body:
                chatBody.substring(0, 500),
              tag:
                String(chatTag),
              responseHeaders:
                chatHeaders,
            };
          }

          return {
            ok: false,
            confirmed: false,
            channel: 'chat-unconfirmed',
            status: chatResponse.status,
            body:
              'Dating.com принял запрос, но не подтвердил сохранение сообщения. ' +
              'Не отправляйте это же сообщение повторно. Проверьте состояние ' +
              'Chat этого контакта в Dating.com.',
            tag:
              String(chatTag),
            responseHeaders:
              chatHeaders,
          };
        }

        // From here the channel is definitely Letter.
        if (
          !latestIncomingLetter ||
          !latestIncomingLetter.meta ||
          !latestIncomingLetter.meta.letter
        ) {
          return {
            ok: false,
            confirmed: false,
            channel: 'letter-unavailable',
            status: 0,
            body:
              'Dating.com определил диалог как Letter, но не предоставил ' +
              'reply-letter-id. Откройте контакт в Dating.com и проверьте ' +
              'доступное действие.',
            tag: '',
            responseHeaders: {},
          };
        }

        if (text.length < 300) {
          return {
            ok: false,
            confirmed: false,
            channel: 'letter-required',
            status: 0,
            body:
              'Для этого контакта требуется письмо Dating.com. ' +
              `Текущая длина: ${text.length}. Минимум: 300 символов.`,
            tag: '',
            responseHeaders: {},
          };
        }

        const letterRandom = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
        const letterTag = Number(`${Date.now()}${letterRandom}`);

        const firstSentence = normalizeText(text)
          .split(/[.!?]/)[0]
          .trim()
          .substring(0, 80);

        const subject = firstSentence.length >= 3 ? firstSentence : 'Hello';

        const letterPayload = {
          attachments: [],
          cover: String(latestIncomingLetter.meta.cover || '6a205f'),
          generation: {
            used: true,
            'reply-letter-id': String(latestIncomingLetter.meta.letter),
            'request-id': crypto.randomUUID(),
          },
          'letter-category': 'reply',
          recipient: contactId,
          sender: operatorId,
          subject,
          tag: letterTag,
          text,
        };

        const letterResponse = await fetch(
          `https://api.dating.com/dialogs/letters/${contactId}/${operatorId}`,
          {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify(letterPayload),
          }
        );

        const letterBody = await letterResponse.text().catch(() => '');
        const letterHeaders = collectResponseHeaders(letterResponse);

        await sleep(5_000);

        const afterLetter = await getDialogMessages();
        let confirmedLetter = findConfirmedOutgoing(afterLetter, letterTag);

        if (!confirmedLetter) {
          const lettersResponse = await fetch(
            `https://api.dating.com/dialogs/letters/${operatorId}` +
            `?omit=0&participant=${contactId}&select=20`,
            {
              method: 'GET',
              credentials: 'include',
              headers,
            }
          );

          if (lettersResponse.ok) {
            const lettersData = await readJson(lettersResponse);
            const letterObjects = findObjects(lettersData);

            confirmedLetter = letterObjects.find(letter => (
              String(letter.sender || '') === operatorId &&
              (
                String(letter.tag || '') === String(letterTag) ||
                textMatches(letter.text || letter.message || '')
              )
            ));
          }
        }

        return {
          ok: !!confirmedLetter,
          confirmed: !!confirmedLetter,
          channel: 'letter',
          status: letterResponse.status,
          body: letterBody.substring(0, 500),
          tag: String(letterTag),
          responseHeaders: letterHeaders,
          subject,
          replyLetterId: String(latestIncomingLetter.meta.letter),
        };
      },
      { operatorId, contactId, text, apiHeaders }
    );
  } catch (e) {
    result = {
      ok: false,
      confirmed: false,
      channel: 'exception',
      status: 0,
      body: e.message,
      responseHeaders: {},
    };
  }

  if (!result.ok || !result.confirmed) {
    const headersText = JSON.stringify(result.responseHeaders || {});
    const reason =
      result.body ||
      `Dating.com HTTP ${result.status}: message was not confirmed. ` +
      `Response headers: ${headersText}`;

    await finishOutgoingQueueItem(
      reqCtx,
      queueId,
      'error',
      result.status || 0,
      reason
    ).catch(() => {});

    warn(
      `Outbox #${queueId}: channel=${result.channel || 'unknown'} ` +
      `status=${result.status || 0} ${reason}`
    );

    return { processed: 0, errors: 1 };
  }

  await finishOutgoingQueueItem(
    reqCtx,
    queueId,
    'sent',
    result.status || 0,
    ''
  );

  log(
    `  ↑ confirmed queue=${queueId} contact=${contactId} ` +
    `channel=${result.channel} status=${result.status}`
  );

  return { processed: 1, errors: 0 };
}


async function runOneSyncCycle(page, reqCtx) {
  const intercepted = new Map();
  let datingAuthHeader = '';

  const configuredOperatorId = String(config.operatorId || '').trim();

  const resolvePair = (first, second) => {
    const operatorId = configuredOperatorId || String(first);

    let contactId = String(second);
    if (String(first) === operatorId) {
      contactId = String(second);
    } else if (String(second) === operatorId) {
      contactId = String(first);
    }

    return { operatorId, contactId };
  };

  const saveDialog = (operatorId, contactId, messages, source) => {
    if (!Array.isArray(messages) || messages.length === 0) return;

    const current = intercepted.get(String(contactId));

    if (!current || messages.length >= current.messages.length) {
      intercepted.set(String(contactId), {
        operatorId: String(operatorId),
        messages,
      });
    }

    if (TEST_MODE) {
      log(
        `  ↓ ${source} contact=${contactId} ` +
        `op=${operatorId} msgs=${messages.length}`
      );
    }
  };

  const onRequest = (request) => {
    const url = request.url();
    if (!url.includes('api.dating.com')) return;

    const auth = request.headers().authorization;
    if (auth) datingAuthHeader = auth;
  };

  const onResponse = async (response) => {
    const url = response.url();
    const match = url.match(
      /api\.dating\.com\/dialogs\/messages\/(\d+):(\d+)/
    );

    if (!match || response.status() !== 200) return;

    const { operatorId, contactId } = resolvePair(match[1], match[2]);

    try {
      const data = await response.json();
      saveDialog(operatorId, contactId, data, 'intercepted');
    } catch {
      // Пустой или не JSON-ответ.
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    const inboxUrl =
      config.inboxUrl || 'https://dating.com/en/people/#inbox';

    log(`Navigating to inbox: ${inboxUrl}`);

    await page.goto(inboxUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // Даём React и запросам Dating.com полностью загрузиться.
    await page.waitForTimeout(8_000);

    const detectedOperatorId = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const match = text.match(/User's ID:\s*(\d+)/);
      return match ? match[1] : '';
    });

    const operatorId =
      configuredOperatorId || String(detectedOperatorId || '');

    const contactIds = await page.evaluate(
      ({ operatorId, maxContacts }) => {
        const ids = new Set();

        const add = (value) => {
          const id = String(value || '').trim();

          if (
            /^\d{8,15}$/.test(id) &&
            id !== String(operatorId || '')
          ) {
            ids.add(id);
          }
        };

        const selectors = [
          'li.emails-item[data-sender]',
          '.emails-item[data-sender]',
          '[data-sender]',
          '[data-recipient]',
          '.chat-list-item[data-user-id]',
          '[data-contact-id]',
        ];

        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            add(el.getAttribute('data-sender'));
            add(el.getAttribute('data-recipient'));
            add(el.getAttribute('data-user-id'));
            add(el.getAttribute('data-contact-id'));
          }
        }

        return Array.from(ids).slice(0, maxContacts);
      },
      {
        operatorId,
        maxContacts: MAX_CONTACTS,
      }
    );

    log(
      `Inbox contacts: operator=${operatorId || 'none'} ` +
      `ids=${contactIds.length}` +
      (contactIds.length
        ? ` sample=${contactIds.slice(0, 5).join(',')}`
        : '')
    );


    /*
     * New-account contact discovery.
     *
     * New Dating.com accounts can expose incoming people through API-backed
     * Chat Requests / introductory events while the Inbox DOM contains no
     * contact identifiers.
     *
     * Canonical IDs:
     * - event["user-id"]
     * - event["user-details"].id
     * - letter.sender
     *
     * Do NOT use arbitrary numeric values, payload sender-id values or
     * automation production consumers as contact IDs.
     *
     * Discovery is intentionally larger than MAX_CONTACTS. A rotating window
     * is selected each cycle so contacts beyond the first MAX_CONTACTS are not
     * permanently starved.
     */
    if (operatorId) {
      for (
        let attempt = 0;
        attempt < 10 && !datingAuthHeader;
        attempt++
      ) {
        await page.waitForTimeout(300);
      }

      if (datingAuthHeader) {
        const existingIds = new Set(
          contactIds.map(String)
        );

        const discoveredIds = [];
        const discoveredSet = new Set();

        const addDiscoveredId = (raw) => {
          if (
            raw === undefined ||
            raw === null
          ) {
            return;
          }

          const id = String(raw);

          if (
            !/^\d{8,15}$/.test(id) ||
            id === String(operatorId) ||
            existingIds.has(id) ||
            discoveredSet.has(id)
          ) {
            return;
          }

          discoveredSet.add(id);
          discoveredIds.push(id);
        };

        const headers = {
          authorization: datingAuthHeader,
          accept: 'application/json',
          referer: 'https://www.dating.com/',
        };

        const discoverySources = [
          {
            name: 'invitation-events',
            url:
              `https://api.dating.com/users/${operatorId}` +
              `/events?omit=0&select=100&types=%2Binvitation`,
            extract(data) {
              if (!Array.isArray(data)) {
                return;
              }

              for (const event of data) {
                addDiscoveredId(
                  event?.['user-id'] ??
                  event?.['user-details']?.id
                );
              }
            },
          },

          {
            name: 'introductory-events',
            url:
              `https://api.dating.com/users/${operatorId}` +
              `/events?omit=0&select=100&types=%2Bintroductory%2Bletter`,
            extract(data) {
              if (!Array.isArray(data)) {
                return;
              }

              for (const event of data) {
                addDiscoveredId(
                  event?.['user-id'] ??
                  event?.['user-details']?.id
                );
              }
            },
          },

          {
            name: 'unreplied-letters',
            url:
              `https://api.dating.com/dialogs/letters/${operatorId}` +
              `?direction=in&omit=0&replied=false&select=100`,
            extract(data) {
              if (
                !data ||
                !Array.isArray(data.letters)
              ) {
                return;
              }

              for (const letter of data.letters) {
                addDiscoveredId(
                  letter?.sender
                );
              }
            },
          },
        ];

        const discoveryStatuses = {};

        /*
         * Read every canonical discovery source.
         * Do not stop simply because MAX_CONTACTS has been reached.
         * MAX_CONTACTS applies only to the selected processing window.
         */
        for (const source of discoverySources) {
          try {
            const response =
              await reqCtx.get(
                source.url,
                { headers }
              );

            discoveryStatuses[source.name] =
              response.status();

            if (!response.ok()) {
              continue;
            }

            const raw =
              await response.text();

            if (!raw) {
              continue;
            }

            let data;

            try {
              data = JSON.parse(raw);
            } catch {
              continue;
            }

            source.extract(data);

          } catch (error) {

            discoveryStatuses[source.name] = 0;

            warn(
              `API contact discovery ${source.name} failed: ` +
              `${error.message}`
            );
          }
        }

        const availableSlots =
          Math.max(
            0,
            MAX_CONTACTS - contactIds.length
          );

        let selectedIds = [];
        let cursorBefore = 0;
        let cursorAfter = 0;

        if (
          availableSlots > 0 &&
          discoveredIds.length > 0
        ) {
          const previousCursor =
            Number(
              globalThis.__dcDiscoveryCursor || 0
            );

          cursorBefore =
            previousCursor %
            discoveredIds.length;

          const rotated = [
            ...discoveredIds.slice(
              cursorBefore
            ),
            ...discoveredIds.slice(
              0,
              cursorBefore
            ),
          ];

          selectedIds =
            rotated.slice(
              0,
              availableSlots
            );

          for (const id of selectedIds) {
            contactIds.push(id);
          }

          cursorAfter =
            (
              cursorBefore +
              selectedIds.length
            ) %
            discoveredIds.length;

          globalThis.__dcDiscoveryCursor =
            cursorAfter;
        }

        log(
          `API contact discovery: operator=${operatorId} ` +
          `discovered=${discoveredIds.length} ` +
          `selected=${selectedIds.length} ` +
          `total=${contactIds.length} ` +
          `cursor=${cursorBefore}->${cursorAfter} ` +
          `statuses=${JSON.stringify(discoveryStatuses)}` +
          (
            selectedIds.length
              ? ` sample=${selectedIds.slice(0, 5).join(',')}`
              : ''
          )
        );

      } else {

        warn(
          'API contact discovery skipped: ' +
          'Dating.com authorization was not captured'
        );
      }
    }

    const clickContact = async (contactId) => {
      const selectors = [
        `.chat-list-item[data-user-id="${contactId}"]`,
        `li.emails-item[data-sender="${contactId}"]`,
        `.emails-item[data-sender="${contactId}"]`,
        `[data-sender="${contactId}"]`,
        `[data-recipient="${contactId}"]`,
        `[data-contact-id="${contactId}"]`,
      ];

      for (const selector of selectors) {
        const locator = page.locator(selector).first();

        if ((await locator.count()) === 0) continue;

        try {
          await locator.evaluate((el) => {
            el.scrollIntoView({
              block: 'center',
              inline: 'center',
            });

            el.dispatchEvent(
              new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                view: window,
              })
            );

            el.dispatchEvent(
              new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                view: window,
              })
            );

            el.click();
          });

          return true;
        } catch {
          // React мог перерисовать конкретный элемент.
        }
      }

      return false;
    };

    /*
     * Заголовок Authorization обычно появляется уже при загрузке inbox.
     * Если нет — открываем несколько контактов стабильным DOM-кликом,
     * чтобы Dating.com сам выполнил авторизованный запрос.
     */
    if (!datingAuthHeader) {
      for (const contactId of contactIds.slice(0, 5)) {
        await clickContact(contactId);
        await page.waitForTimeout(1_500);

        if (datingAuthHeader) break;
      }
    }

    log(
      `Dating API authorization: ` +
      `${datingAuthHeader ? 'captured' : 'missing'}`
    );

    /*
     * Основной стабильный путь:
     * читаем каждый найденный диалог напрямую тем же авторизованным
     * API-запросом, который выполняет сам интерфейс Dating.com.
     */
    if (
      datingAuthHeader &&
      operatorId &&
      contactIds.length > 0
    ) {
      const directResults = await page.evaluate(
        async ({ operatorId, contactIds, authHeader }) => {
          const results = [];

          for (const contactId of contactIds) {
            const url =
              `https://api.dating.com/dialogs/messages/` +
              `${operatorId}:${contactId}?omit=0&select=50`;

            try {
              const response = await fetch(url, {
                method: 'GET',
                mode: 'cors',
                cache: 'no-store',
                headers: {
                  accept: 'application/json, text/plain, */*',
                  authorization: authHeader,
                },
              });

              let messages = [];

              if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data)) messages = data;
              }

              results.push({
                contactId,
                status: response.status,
                messages,
              });
            } catch (error) {
              results.push({
                contactId,
                status: 0,
                messages: [],
                error: String(error),
              });
            }
          }

          return results;
        },
        {
          operatorId,
          contactIds,
          authHeader: datingAuthHeader,
        }
      );

      const statuses = {};

      for (const result of directResults) {
        const key = String(result.status);
        statuses[key] = (statuses[key] || 0) + 1;

        saveDialog(
          operatorId,
          result.contactId,
          result.messages,
          'direct-api'
        );
      }

      log(
        `Direct API scan: operator=${operatorId} ` +
        `ids=${contactIds.length} ` +
        `dialogs=${intercepted.size} ` +
        `statuses=${JSON.stringify(statuses)}`
      );
    }

    /*
     * Резервный путь для контактов, которые не были возвращены
     * прямым API: заново ищем DOM-элемент перед каждым кликом,
     * поэтому React-перерисовка больше не ломает список handles.
     */
    let clicked = 0;

    for (const contactId of contactIds) {
      if (intercepted.has(contactId)) continue;

      const responsePromise = page
        .waitForResponse(
          (response) => {
            const url = response.url();

            return (
              response.status() === 200 &&
              url.includes('/dialogs/messages/') &&
              (
                url.includes(`${operatorId}:${contactId}`) ||
                url.includes(`${contactId}:${operatorId}`)
              )
            );
          },
          { timeout: 5_000 }
        )
        .catch(() => null);

      const didClick = await clickContact(contactId);

      if (didClick) {
        clicked++;
        await responsePromise;
        await page.waitForTimeout(300);
      }
    }

    log(
      `Dialog fallback: clicked=${clicked} ` +
      `captured=${intercepted.size}`
    );

    await page.waitForTimeout(2_000);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }

  if (intercepted.size === 0) {
    log('No dialogs captured this cycle.');
    return { imported: 0, errors: 0 };
  }

  log(`Intercepted ${intercepted.size} dialog(s). Posting to CRM...`);

  let totalImported = 0;
  let errors = 0;

  for (const [
    contactId,
    { operatorId, messages },
  ] of intercepted) {
    try {
      const result = await postDialogToCRM(
        reqCtx,
        operatorId,
        contactId,
        messages
      );

      if (result?.success) {
        const imported = result.data?.imported ?? 0;
        totalImported += imported;

        log(
          `  ✓ contact=${contactId} ` +
          `new=${imported} ` +
          `total=${result.data?.total_messages ?? '?'}`
        );
      } else {
        warn(
          `  ✗ contact=${contactId} CRM error:`,
          result?.data
        );
        errors++;
      }
    } catch (e) {
      warn(
        `  ✗ contact=${contactId} POST failed: ${e.message}`
      );
      errors++;
    }
  }

  log(
    `Cycle done. New messages: ${totalImported}. ` +
    `Errors: ${errors}.`
  );

  return {
    imported: totalImported,
    errors,
  };
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
      const outbound = await processOutgoingQueue(page, reqCtx);
      const { imported, errors } = await runOneSyncCycle(page, reqCtx);
      if (outbound.processed > 0 || outbound.errors > 0) {
        log(`Outbound cycle: sent=${outbound.processed} errors=${outbound.errors}`);
      }
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
