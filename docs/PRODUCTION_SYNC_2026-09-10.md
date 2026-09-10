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
