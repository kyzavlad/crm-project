# DC Connector — Background Dating.com sync for WordPress CRM

Keeps a real Dating.com browser session alive in the background.
When Dating.com's own JavaScript loads dialog messages, the connector
intercepts those responses and posts them to the CRM's existing import
endpoint — the same logic as the manual bookmarklet, running automatically.

Dating.com session cookies stay inside the Playwright browser profile
(`.session/`) and are **never** sent to the CRM server.

---

## Prerequisites

- Node.js ≥ 18
- A VPS or machine that can run a persistent process alongside WordPress
- The target Dating.com model account credentials
- The CRM model post ID and import token (from the model detail page)

---

## Setup

### 1. Install dependencies

```bash
cd connector
npm install
npx playwright install chromium
```

### 2. Create config

```bash
cp config.example.js config.js
```

Edit `config.js`:

| Key | Where to find it |
|---|---|
| `crmUrl` | Your WordPress site URL |
| `modelId` | Open the CRM model page → look at the URL (`?p=42`) or the sync panel |
| `importToken` | CRM model page → "DC Sync" panel → expand "Конфиг для коннектора" |
| `dcEmail` | Dating.com login e-mail for this model |
| `dcPassword` | Dating.com login password |
| `inboxUrl` | Dating.com chat/inbox URL — try `https://dating.com/` first |

### 3. First run (visible browser — verify login)

```bash
node dc-connector.js --test
```

Set `headless: false` in `config.js` for the first run so you can see the
browser and complete any captcha or 2FA if Dating.com prompts for it.
The session is saved in `.session/` and reused automatically on subsequent runs.

### 4. Verify CRM import

After a test run, open the CRM model page. The "Фоновый коннектор" status
badge should turn green with the last sync time. Click a contact to verify
messages are visible.

---

## Running continuously

### PM2 (recommended)

```bash
npm install -g pm2
pm2 start dc-connector.js --name dc-connector --cwd /path/to/connector
pm2 save
pm2 startup  # follow the printed command to auto-start on reboot
```

Logs: `pm2 logs dc-connector`
Restart: `pm2 restart dc-connector`

### systemd

```ini
# /etc/systemd/system/dc-connector.service
[Unit]
Description=Dating.com CRM background connector
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/crm-project/connector
ExecStart=/usr/bin/node dc-connector.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now dc-connector
journalctl -u dc-connector -f
```

### Cron (simple alternative — restarts every 5 minutes)

Not recommended for production because each cron run relaunches the browser.
Prefer PM2 or systemd for persistent operation.

```
*/5 * * * * cd /path/to/crm-project/connector && node dc-connector.js --test >> connector.log 2>&1
```

---

## Configuration reference

| Key | Default | Notes |
|---|---|---|
| `pollIntervalMs` | `60000` | Minimum 15 000 ms enforced |
| `maxContactsPerRun` | `10` | Max dialogs to click per cycle |
| `headless` | `true` | `false` shows the browser window |
| `testMode` | `false` | One cycle then exit, verbose logs |
| `inboxUrl` | `https://dating.com/` | Adjust if Dating.com uses `/chat/` |

---

## Troubleshooting

**"No dialog items found via click-through"**
Dating.com may have updated its HTML. Set `headless: false`, run with `--test`,
and inspect the page. Update `DIALOG_SELECTORS` in `dc-connector.js` to match
the new element selectors.

**"Login may have failed — no logged-in indicator found"**
The login page structure may have changed, or captcha was shown. Run with
`headless: false` and complete login manually once to save the session.

**"CRM HTTP 403" or "Недействительный токен"**
The import token has been regenerated. Re-copy it from the CRM sync panel into
`config.js`.

**Status badge shows "Ошибка" in CRM**
Check connector logs (`pm2 logs dc-connector` or `journalctl`).

---

## Outgoing replies

The connector currently only **receives** messages. Sending from CRM through
this connector is possible in principle (the browser session is active), but
requires:
1. Confirming the Dating.com "send message" API endpoint and payload
2. A CRM queue for operator-composed messages
3. The connector polling the queue and submitting via the browser session

This is planned as a separate phase and is NOT implemented here.

---

## Security notes

- `config.js` is in `.gitignore` — never commit it
- `.session/` is in `.gitignore` — treat it like a cookie jar
- The connector identifies itself to the CRM only with the import token (no WP session)
- Dating.com session cookies never leave the Playwright browser process
- No captcha bypass, no Akamai bypass — the real browser handles all of that
