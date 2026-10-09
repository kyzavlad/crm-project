# Dating.com paid-baseline incident — 2026-10-09

Production site: crmrc.app. Existing source repository: kyzavlad/crm-project. This note records an incident checkpoint, not deployment acceptance.

## Verified live symptoms
- Four vCPU VPS under extreme hypervisor CPU steal (two vmstat samples: 90% and 87%; load ~17.72) with adequate available RAM (~13 GiB).
- The established connector services repeatedly fail Dating.com fresh/re-login with a timeout waiting for a visible email field. Process-active status is not successful synchronization.
- WordPress outbox (read-only aggregate): Svetlana model 343 has 10 pending, Tatiana model 374 has 2 pending, Anton model 350 has 1 pending and Valentin model 366 has 1 pending. These pending items had zero attempts at inspection. Never blindly replay or re-enqueue old messages; reconcile provider state first.
- Real source contact timestamps are 13-digit Unix milliseconds. WordPress uses fixed +03:00, PHP server timezone is UTC. The live Dating-only display code used date(), yielding incorrect local times and potential invalid ms rendering.

## Staged local fix — NOT DEPLOYED
- Only Dating.com PHP file: wp-content/themes/romance-crm/dating-com-functions.php.
- Live baseline file SHA-256: e0d709a5cfd18c1196d373f6b8e60488f4dc9d79d7feb2bf54ac44e915d0b239.
- Corrected staged PHP SHA-256: 64a1be806f87c406cba81e80866943c1d346d73d22e171074b6171094066e83f.
- Change is confined to three time-rendering callsites: wp_date() with named Europe/Kyiv timezone (correct DST), and dc_safe_timestamp() for contact milliseconds. No global WordPress timezone changes, no RomanceCompass edits.
- PHP lint PASS; nine isolated timestamp/render checks PASS, including real-format milliseconds, midnight crossover, escaping, and winter DST. This is not real WordPress/provider E2E acceptance.
- Deployment/rollback script staged on authorized Jarvis host at /home/vladops/jarvis-crmprod-stage/deploy-dating-time-20261009.sh. Script SHA-256: 833afb544a010f520c288ff004f54094367dd7413c91159c613a64d2b3195732. Exact owner approval is still required under D-097. NO production write has occurred in this checkpoint.

## Open gates
1. Provider must investigate/remediate extreme CPU steal; do not equate service activation with functioning login.
2. Obtain owner approval bound to precise deploy-script SHA; perform backup, precondition check, lint, bounded deploy, health check and rollback if required.
3. Independently verify actual source inbound/outbound delivery and Dating timestamps against live CRM after restored authorization, without duplicate outbound.
4. Client was already answered on 2026-10-09 at 15:31 Kyiv. Do not send a repeat. Separate $600 module is unpaid/out of scope.

## Approved time-only production deploy — 2026-10-09
- Owner explicitly approved exact script SHA-256 `833afb544a010f520c288ff004f54094367dd7413c91159c613a64d2b3195732`, scoped to Dating.com time V3 with backup/rollback.
- Executed on authorized production path. Script returned `DEPLOY_OK`, HTTPS 200; production PHP SHA-256 `64a1be806f87c406cba81e80866943c1d346d73d22e171074b6171094066e83f`. Preserved baseline backup at `/root/crmrc-backups/dating-time-20261009-20261009T151448Z/dating-com-functions.php` (SHA-256 `e0d709a5cfd18c1196d373f6b8e60488f4dc9d79d7feb2bf54ac44e915d0b239`).
- Post-deploy diff restricted to three Dating.com timestamp render expressions. PHP syntax PASS; live WordPress QA from stored real source timestamps: Svetlana model 343 raw `1791558128750` -> `09.10 18:02` Kyiv PASS; Tatiana model 374 raw `1791423918410` -> `08.10 04:45` Kyiv PASS; `dc_render_chat_message` real function PASS; winter 2026-11-01 conversion PASS; HTTP 200. No test outgoing message sent and no RomanceCompass code mutated.
- Outbox before deploy: 343/Svetlana had 10 pending; those 10 naturally became database status `sent` by 14:58 UTC, BEFORE the time patch deployment at 15:14 UTC. Database `sent` alone is not independent end-recipient confirmation. Anton 350 formerly had one pending; post-deploy readback showed one new error at 14:48 UTC. Tatiana 374 still has two pending.
- Post-deploy source sync: Svetlana completed multiple inbound cycles at 15:10–15:15 UTC with `Errors: 0`; Tatiana continued to fail relogin `locator.fill: Timeout 20000ms exceeded` and startup. New vmstat steal still excessive (59–64% for two intervals). Service state does not equal E2E acceptance.
- **TIME DISPLAY FIX DEPLOYED + RUNTIME UNIT QA PASS. PAID BASELINE LOGIN/OUTBOUND/PROVIDER E2E REMAINS OPEN.** No manual queue replay, no duplicate client message, no $600 module, no broader production deploy. Canonical branch's PHP code may differ from live until separately audited/source-synced; this document is deployment evidence, not a claim of source parity.
