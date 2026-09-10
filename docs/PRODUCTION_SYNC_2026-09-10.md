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
