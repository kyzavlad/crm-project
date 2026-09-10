# Production sync checkpoint — 2026-09-10

## Verified production facts

Read-only audit was run against `/var/www/fastuser/data/www/crmrc.app`.

- Production site directory is **not** a Git working tree.
- Connector directories present:
  - `connector-anton`
  - `connector-igor`
  - `connector-stanislava`
- Active systemd services observed:
  - `dc-connector-anton.service`
  - `dc-connector-igor.service`
- `connector-stanislava` exists but no active service was shown in the audit output.
- The first recursive marker scan was interrupted manually before completion; no conclusion should be drawn from that incomplete step.

## Repository state

`kyzavlad/crm-project` is the existing sanitized source repository and must be preserved. Production contains newer changes than the repository snapshot, so `main` must not be deployed over production until the current live source has been compared and synchronized.

## Safe sync plan

1. Read current live connector code and unit files without exposing credentials, cookies, browser profiles, database content, or WordPress secrets.
2. Identify the newest production connector implementation and V4/V4.2 markers with bounded commands that do not traverse browser/session data.
3. Copy only sanitized source/config templates into this branch.
4. Compare live source with repository `main`.
5. Implement an idempotent provisioning workflow for additional profiles without duplicating connector logic.
6. Test syntax and service template behavior before any production mutation.
7. Provision the next profile only after the current production source is captured and rollback is defined.
8. Verify runtime and update the Business OS after successful provisioning.

## Security rule

Never commit `config.js`, `.session/`, cookies, credentials, tokens, logs containing secrets, database dumps, `wp-config.php`, or private uploads.

## Source capture after remote terminal connection

Bounded source capture verified the live connector implementations and syntax:

- Anton: 1598 lines, SHA-256 `78bd052c8ea79f45b50c4560441e95ea65c13e391ca1174b2951217c9bfa8292`.
- Igor: 1907 lines, SHA-256 `38beb741efd5867ff85bc98384d3420abb4c9a8a94c43247f92d7c485d85c443`.
- Stanislava: 1783 lines, SHA-256 `f3efb2050019c60894529dba19098bc3be8c6a91374f5a60a6421a0efda907e6`.

Igor is the newest superset: it contains `DC_DIALOG_HISTORY_MERGE_V42`, `DC_CHAT_CONFIRM_POLL_V42`, and `DC_CHANNEL_CLASSIFIER_V5`. Anton already had V5 but not V4.2; Stanislava was older. No hard-coded model identifiers were found in Igor source; profile-specific values remain in ignored `config.js`.

A production outbox attempt exposed a V5 regression: the browser-context `page.evaluate()` callback called the Node-side `log()` function and failed with `ReferenceError: log is not defined`. The canonical branch source removes that invalid cross-context logger call while preserving classifier behavior.

## Final production outcome

The latest profile was identified in CRM as model post `366` (Valentyn). During the first smoke test, CRM contained an incorrect Dating operator ID. Live Dating.com login confirmed the profile ID as `116328162931`; CRM `id_model` and the generated connector config were corrected before production service activation.

Fresh-login handling was hardened in the canonical connector (`DC_LOGIN_INBOX_ENTRY_V9`, exact password-mode switch, and form-scoped submit). A clean session test then completed successfully and imported real dialogs with zero connector errors.

`dc-connector-valentin.service` is enabled and active. Multiple production cycles completed with `Errors: 0`; CRM background status is `ok`, error is empty, and 38 contacts were present at final verification. There were no pending/processing outbox rows for model 366.

Igor was upgraded to the same canonical runtime after a bounded diff showed only the fresh-login changes relative to his already-fixed V4.2/V5 implementation. Post-restart Igor completed a production cycle with zero errors. Anton remained untouched and continued zero-error cycles. Stanislava remains intentionally inactive.

Canonical runtime SHA-256 at final verification: `6c434d250fe95e92e06d6d4fbff81ad9d6d42e355ea0f875507cfb243fb1be2d`; it matched `connector-runtime`, Igor, and Valentyn. Temporary login diagnostics, temporary configs, failed session copies, and credential-bearing backup config were removed from Valentyn's production connector directory.
