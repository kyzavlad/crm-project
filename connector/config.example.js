/**
 * dc-connector configuration template.
 * Copy this file to config.js and fill in your values.
 * NEVER commit config.js to git — it contains real credentials.
 *
 * Where to find model_id and importToken:
 *   Open the CRM model detail page → scroll down to the Dating.com sync panel
 *   → expand "Конфиг для фонового коннектора".
 */

module.exports = {

  // ── WordPress CRM ────────────────────────────────────────────────────────
  crmUrl:      'https://your-crm-domain.com',   // No trailing slash
  modelId:     0,                               // WP post ID of the Dating.com model
  importToken: '',                              // 40-char token from the CRM sync panel

  // ── Dating.com account ───────────────────────────────────────────────────
  dcEmail:    'model@example.com',              // Dating.com login e-mail
  dcPassword: '',                               // Dating.com login password

  // URL where Dating.com loads the dialog/inbox list.
  // Usually https://dating.com/ or https://dating.com/chat/
  inboxUrl: 'https://dating.com/',

  // ── Connector behaviour ──────────────────────────────────────────────────
  pollIntervalMs:    60_000,   // How often to sync (ms). 60s minimum recommended.
  maxContactsPerRun: 10,       // Max dialogs to open per sync cycle.
  headless:          true,     // false = show the browser window (useful for debugging).

  // testMode: single cycle, verbose logs, exits after one run.
  // Enable with --test flag or set true here.
  testMode: false,

};
