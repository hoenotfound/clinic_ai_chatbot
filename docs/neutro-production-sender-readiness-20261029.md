# Neutro Sense — paid Render primary-sender readiness (2026-10-29)

## Scope
This is **Step 1 only**: prepare the existing paid Neutro service and registry for two-number support. It is **not** authorization to scan +60 17-483 1336's Coexistence QR, import its real history, change Meta callbacks, send messages from the second number, deploy the paid service, or enable AI/follow-ups.

## Verified production baseline (read-only except primary registration)
- Paid Render service: `srv-daqd1rp42hec7398itr0`, `main`, **auto-deploy disabled**, live SHA `6927cb480d188fcab75844a4bf7a696f16e0ae75`.
- Production Neon project `steep-forest-44509907`, database `neondb`, migration 106.
- Before registration: 230 WhatsApp contacts, 15 Facebook contacts, 3,141 messages, 0 scoped contacts, 0 scoped conversations, 0 sender accounts.
- **Completed on 2026-10-29:** atomic metadata-only insertion into `whatsapp_sender_accounts` of sender key `neutro`, Meta phone ID `1408739622311791`, Meta account ID `1593376338308612`, state `active`, coexistence `false`. IDs match the independently rehearsed QA primary registration and the production routing runbook. No WhatsApp token stored.
- Verified immediately afterward: exactly one primary sender; all 230 WhatsApp contacts, 15 Facebook contacts and 3,141 messages unchanged; all legacy contacts remain unbound, and no sender conversations were added. **Do not batch backfill legacy contact IDs/messages.** The main branch can apply a display-only virtual primary label while retaining legacy identities.
- No second-number sender registration is permitted until exact Meta account/phone ownership is independently verified via the real signup. Never copy personal-QA IDs, credentials, billing state, history or receipts into Neutro.
- The paid production service was not redeployed, and no Meta callback or production environment variable was changed as part of this registration.

## Reviewed code delta
- Main already contains merged multi-number PR #395. Do **not** merge the staging branch wholesale: it contains QA-only callback routing, credential-vault and receipt-only switches.
- This focused PR promotes **only** the confirmed real Meta `wamid.` Base64-padding parser fix into the production sender-scoped receipt service, plus unit and disposable-PostgreSQL regression tests. It does not touch Neutro primary delivery, Facebook/Instagram handlers, migrations, routing, Meta credentials or production service configuration.
- Meta HMAC, sender/WABA/phone matching, recipient checks, strict receipt idempotency and billing holds remain in place.

## Release gates (stop before any production code deploy or QR)
1. Require full GitHub PR CI on its final head, including backend/Postgres receipt tests and desktop/iPhone/iPad portal checks. Passing CI is not proof of real Meta delivery.
2. Confirm paid Render's production branch and **auto-deploy disabled**, take/verify Neon point-in-time restore capability and preserve the exact live Render commit. Prefer a production deploy in a supervised quiet period after explicit approval.
3. Review all production environment variables *in the Render dashboard* without printing secrets. Confirm `WHATSAPP_SECONDARY_STAFF_SEND_ENABLED`, `WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED`, `WHATSAPP_SECONDARY_AI_SEND_ENABLED`, `WHATSAPP_SECONDARY_AI_MEDIA_ENABLED`, `WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED`, `WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED`, `WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED`, `WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED`, `PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED` and all real-clinic QR approvals **OFF**. Changing Render environment variables triggers a deployment, so do not set them merely to check them.
4. With the primary sender metadata registered, the existing primary WhatsApp/Messenger/Instagram behavior must remain unchanged. Check primary signed webhook, a consented inbound message and one approved outbound reply, media, active follow-ups and user/staff inbox. Also test Messenger and Instagram independently where connected; a Facebook contact count does not prove live IG delivery.
5. Recheck current Meta app-default, Neutro account-specific callback and signed routing before the actual second-number QR. If any primary / Messenger / Instagram regression appears, **STOP**: do not activate the secondary identity or blindly roll back database migrations.
6. Only after a separately approved supervised rollout may +60 17-483 1336 be signed up, verified and registered as a **separate** active sender; initialize the per-number history receiver first, then capture explicit history consent and trigger its once-only sync. Keep second-number staff sends, AI, media, templates and follow-ups OFF until separately tested and approved.

## Safe read-only verification queries
```sql
SELECT sender_key,meta_phone_number_id,meta_account_id,state,coexistence_enabled
FROM whatsapp_sender_accounts ORDER BY sender_key;
SELECT channel,count(*),count(*) FILTER(WHERE whatsapp_sender_id IS NOT NULL) AS scoped
FROM contacts GROUP BY channel;
SELECT count(*) FROM messages;
SELECT count(*) FROM whatsapp_sender_conversations;
```
Never export customer content or raw webhook secrets just to verify this release.
