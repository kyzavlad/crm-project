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
