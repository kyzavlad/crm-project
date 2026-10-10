# Dating.com → crmrc.app, paid $700 baseline: independent read and staging, 2026-10-10

**Scope / permissions:** Time V3 already deployed 2026-10-09 and MUST NOT be redeployed. Paid reliability baseline only. $600 scaling module unpaid / excluded. No messages sent to Jeki and no production write/restart during this pass. Existing RomanceCompass unchanged. New production deploy requires its own exact-script SHA authorization.

## Source-of-truth checks (live CRM VPS srv911637, via SSH crmprod)

- Production Dating time PHP SHA-256 `64a1be806f87c406cba81e80866943c1d346d73d22e171074b6171094066e83f`. The authorized V3 deploy and backup remain in place.
- Connector runtime, Tatiana, Valentin and Igor JS SHA-256 `76206122febe19f685ad0f5007c9194cd87d96a42ba26ad3a55bb876ed62be74`. Anton uses a different proven variant `f7315bb936732399eeaaa278d759ed7a8b9f3ccfed10d3a6cf57bf0386b6a859`.
- Correct Svetlana unit `dc-connector.service`. Live read at ~03:24 UTC: 5 units process-active, lifetime NRestarts Svetlana1625 / Tatiana1136 / Valentin1681 / Anton1557 / Igor1827. These counts are cumulative and process active is not reliable-send proof.
- VPS 4 vCPUs, approx 11GiB memory available. Selected live vmstat CPU steal samples 7%, 19% initially and later 43–61%; historical Oct9 49–90%. High variance is hypervisor contention evidence, not proof of exact provider ownership. Account/hosting owner must be identified through Jeki/Valeria; do not ask Vlad to buy/register a hosting account.
- Valentin repeatedly had Playwright `locator.fill` email selector 20s timeout around 03:20–03:24 UTC. Its live cycles later resumed at 03:30, 03:32, 03:35 UTC with 65,60,60 imported and zero cycle errors. Therefore diagnosis is intermittent, not a currently permanently dead connector. Do not blindly restart a recovered service.
- Dating.com **saved login failure image correlated to Igor (not Valentin)** at 03:28 UTC shows exact `You're currently logged in somewhere else. Please enter your password if you want to close that session.` There is no email input on this overlay, so waiting on the email selector cannot work. Automatic session takeover would disrupt the active account operator; requires human decision. The screenshot was stored locally for investigation, not published.
- Tatiana outbound worker `Outbox pull failed: apiRequestContext.post: Timeout 20000ms exceeded` around 02:34 UTC; worker `sent=0 errors=1`. This is a CRM AJAX pull timeout; it does **not** prove Dating.com rejected that attempt. Other historical Tatiana queue rows were marked error with chat-state restrictions or Dating.com HTTP202 without independently confirmed saved message.
- Current DB queue summary after Oct9 processing: Tatiana `pending=0`, `error=46`, `sent=1`; Svetlana `pending=0`, `sent=988`, `error=191`; no blind replay/re-enqueue. Tatiana sampled error queue IDs 2205 and 2224 were not found in persisted source-dialog history.
- Independent real Dating.com source proof: Svetlana queue IDs 2234–2239 each have an exact text match in the imported source conversation with genuine source message ID and sender=operator. Source timestamps appeared 15–35 s after queue creation. Anton queue ID 2233 similarly matched source history at 138s. These are actual historical sends, not new test sends; provider-side account visibility beyond API/source read not separately UI-tested.
- As of 10 Oct UTC stored source data: Svetlana **10 inbound, 6 outbound**, all with source IDs; Tatiana **1 inbound, 0 outbound**, with a source ID; Valentin newest post-recovery runtime cycles were zero-error but no Oct10 source message timestamp in stored message archive at readback. Do not equate `New messages N` repeated counts with N distinct fresh incoming messages.

## UI failure: reproduced from client screenshot and live code

- Legacy theme `wp-content/themes/romance-crm/functions.php::handle_send_message` contains the exact client-facing `Dating.com: отправка сообщений будет доступна после подтверждения endpoint` error.
- Theme JS `assets/js/main.js` registers a delegated handler for `#chatModal .writemessage button` that calls the legacy AJAX `send_message` path.
- Existing Dating-only mu-plugin `dc-outbound-queue.php` captures document clicks **only when normalized button label is exactly Russian `отправить`**. Client screenshot has a different/localized label; therefore the capture gate misses and legacy theme handler fires. Model page eligibility is Dating-only.
- A safe fix is to also capture the exact legacy button CSS selector independently of text, resolve ID from `#chatModalContent .chat-messages[data-user_id]`, intercept at capture phase and avoid duplicated queue POST. Do not edit shared RomanceCompass handlers.
- Safe staging mock test used the localized button, verified `preventDefault`, `stopPropagation`, `stopImmediatePropagation`, **one** `dc_outbox_enqueue` call with correct modal ID, and no duplicate enqueue on double-click.

## Staged changes — no production deploy

Local authorized staging directory: `/home/vladops/jarvis-crmprod-stage/dating-20261010` (not a web root).

1. `dc-outbound-queue.php.stage` SHA-256 `35eea392009213528f1f50df0452c0f9972df252bd12d3f247438f40d7590c9a`, live baseline `73f9bc19e0c16b99b0780d0ff3b157c415e00daa7c786e63e35d79d7feb2bf7384ae1`. PHP lint + DOM VM simulated enqueue/dedupe PASS. Deploy script `deploy-dating-ui-capture.sh` SHA-256 `a23864a95036e825f00d8f803ac59a9a32009b9eda602bc9b88be368ab57b124`. Script includes live SHA precondition, protected backup, atomic replace, PHP lint, HTTP200, rollback trap. **NOT EXECUTED / SHA OWNER APPROVAL REQUIRED.**
2. `dc-connector-valentin.js.stage` SHA-256 `5b98220c05d156fe8847e79e05fa13955c9dce66bd0148e58498f412d24fab56`, baseline `76206122febe19f685ad0f5007c9194cd87d96a42ba26ad3a55bb876ed62be74`. Recognizes the known another-session overlay and avoids forced takeover, 15min delay instead of immediate email-fill timeout. Node syntax and VM conflict-unit test PASS, but **Valentin-specific conflict UI not yet confirmed** and he has resumed clean cycles. Therefore this is only a conditional diagnostic guard, not a proved cure; do not deploy/restart healthy Valentin just to install it. Isolated script `deploy-valentin-session-diagnostic.sh` SHA-256 `f5c3a4024845a4c2081207841c18ef1cdc1eb5848468f5430e455bb63d1bab1a` also NOT EXECUTED.

## Open acceptance gates

1. Owner to approve exact new UI deployment SHA (independently of previously approved time V3). Then perform permitted gated deploy, authenticated UI capture smoke, backup/rollback proof; no new real message send except a specifically authorized controlled test.
2. For Valentin, prefer observing naturally recovered cycles and a model-specific screenshot on the *next real failure*. Current other-session image belongs to Igor; don't conflate. Coordinate account session ownership with operators instead of forcibly logging them out. Conditional guard approval/deploy only if substantiated.
3. VPS owner via Jeki must bring current CPU steal recordings and request physical-host contention remediation. No request to purchase a new host/VPS, no unapproved restart/migration.
4. Tatiana must prove a fresh natural outgoing by matching an authorized queue item to source ID+timestamp; there is no verified Oct10 Tatiana outbound. Do not replay `error` or HTTP202 uncertain rows.
5. The current proof does NOT certify 24h stability or complete UI acceptance. Keep baseline OPEN.

## Approved SHA preflight blocked before deploy — 2026-10-10

The owner explicitly approved **only** `deploy-dating-ui-capture.sh` SHA-256 `a23864a95036e825f00d8f803ac59a9a32009b9eda602bc9b88be368ab57b124`. The approved script is unchanged. Preflight caught a coding error in its `BASE_SHA` constant: the value has **69 hex digits**, not 64, and does not match the actual original production mu-plugin SHA-256 `73f9bc19e0c16b99b0780d0ff3b157c415e00daa7c786e63e35d79c8a34f4ae1`. Consequently the SHA-bound guard failed before running the deployment. **No file replacement, no service restart, no message send, no rollback action needed.** Live Dating-time PHP remains SHA `64a1be806f87c406cba81e80866943c1d346d73d22e171074b6171094066e83f`, and live outbound mu-plugin remains its original SHA. No new `dc-ui-20261010*` backup directory appeared, confirming no deployment attempt reached the backup phase.

A NEW staged script was prepared by correcting **only** the malformed baseline SHA constant:
- Path: `/home/vladops/jarvis-crmprod-stage/dating-20261010/deploy-dating-ui-capture-v2.sh`
- **NEW script SHA-256 `82df9547159faeb6dc474a85529940ba8b90e60849c16ec9eb7a5ec1ee58840a`**.
- Target staged PHP content unchanged, SHA-256 `35eea392009213528f1f50df0452c0f9972df252bd12d3f247438f40d7590c9a`.
- One-line diff against the formerly approved script: `BASE_SHA` only; shell syntax PASS; PHP lint PASS; behavioral mock for localized submit interception, single enqueue and no duplicate PASS. This mock made **zero network sends**.
- **Deployment V2 NOT executed.** Explicit new owner approval bound to script SHA `82df9547159faeb6dc474a85529940ba8b90e60849c16ec9eb7a5ec1ee58840a` is required before any production mutation, even though functionality and scope remain identical.
