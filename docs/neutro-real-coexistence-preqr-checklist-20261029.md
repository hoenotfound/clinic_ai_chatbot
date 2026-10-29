# Neutro second WhatsApp Business App — pre-QR backend preparation

**Status: PREPARATION ONLY. QR NO-GO until all external receiver checks and separate owner consent pass.**
Date: 29 October 2026. Target: Neutro second WhatsApp Business App, **+60 17-483 1336**.

## Grounded baseline
- Existing paid Render service `srv-daqd1rp42hec7398itr0` on `main`, auto-deploy OFF, live commit `33fe4de7308bfa271a361444b0126bcf6aae26a3` before this PR.
- Production Neon `steep-forest-44509907`, schema migration 106. Primary sender `neutro` is active. **No secondary sender registration or history sync events** were present at the read-only check.
- Actual primary WhatsApp and Facebook Messenger inbound + outbound smoke tests passed after the Oct 29 release. Instagram is not connected.
- The Meta business administration connector lists **Neutro Sense Face & Body**, but reports **“No developer app connected”** for that portfolio. It does not list +60 17-483 1336 as a Cloud API number. This **does not disprove ownership** of its existing WhatsApp Business App number; it means connected API tools cannot certify the new signup/callback today.
- Older runbooks identify the expected paid app-default endpoint as `https://neutrosense.dasmarketingsolution.com/whatsapp/default` and the existing primary account override as `https://neutrosense.dasmarketingsolution.com/webhook`. **These are previously reported settings, not newly verified Meta Graph evidence.** Do not alter either by assumption.

## This PR — *code-only preparation*
1. Supports an exact-phone, **operator-gated, pre-QR Meta identity discovery** for the real clinic second number, without guessing its Meta Cloud API phone ID.
2. Retains mandatory exact phone display/E.164 match, authorized owning Meta account lookup, signed management token introspection, nonprimary phone ID and admin-only one-use session nonce.
3. Adds a **separate production AES-256-GCM encrypted credential vault key**. Personal QA keys/tokens cannot be used as Neutro secondary production credentials, and credentials are never returned to the browser.
4. Keeps the legacy primary WhatsApp, Facebook Messenger and Instagram routes unchanged. Does not add sender records, migrate contact data, change callbacks, send messages, launch history sync or enable AI.
5. Adds negative tests to refuse guessed or wrong IDs, wrong phone, missing consent/receiver confirmation, accidental secondary outbound/media/follow-ups, cross-environment credentials and key reuse.

## New flags — LEAVE OFF until independently verified and separately approved
- `WHATSAPP_SECONDARY_PRE_QR_ID_DISCOVERY_ENABLED`: currently OFF/unset.
- `WHATSAPP_SECONDARY_PRE_QR_RECEIVER_REHEARSED`: OFF/unset; never mark true without actual reviewed signed receiver and history ingestion testing.
- `WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED`: OFF/unset; needs separate explicit QR owner approval. Preparing a PR is NOT that approval.
- `WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED`: OFF/unset; requires an independently generated 32-byte base64 key in `WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY`. **Never copy the personal QA key.**
- Pin `WHATSAPP_SECONDARY_EXPECTED_PHONE_E164` to exact intended real number ONLY during supervised QR preparation, with distinct sender key `neutro_secondary`. Do not set unknown secondary Meta account/phone IDs or outbound token ahead of actual authenticated onboarding.
- Keep all `WHATSAPP_SECONDARY_*SEND*`, `WHATSAPP_SECONDARY_*FOLLOWUPS*`, billable policy, templates, media, `WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED`, passive history importer, direct history dispatcher, and capture-to-Inbox handoff OFF before the verified QR stage.
- The active primary Neutro token and Meta account / phone IDs must not change.

## Hard blockers before real QR
1. **Meta app and number authorization**: independently verify the DA CHATBOT Meta app is authorized for the intended business portfolio and Embedded Signup v4. The connected business tool currently says there is no developer app connected to Neutro Sense Face & Body. Inspect in Meta Business Settings without replacing the working production app association or changing primary credentials.
2. **App-default delivery**: independently verify the actual existing Meta app-default callback and primary account-specific override, including expected subscriptions. No change to primary routing without approval. A successful static GET is not a signed POST delivery test.
3. **Durable signed history receiver**: the current paid app-default bootstrap deliberately does **not** import secondary history. Prepare and test a real secondary-specific, HMAC-verified and durable history receiving path prior to scanning the QR; verify real-provider callback routing, callback ACK and strict sender isolation. The personal QA success is not proof for the clinic identity.
4. **One-time history sync**: prove actual Meta-signed registration / sender identity from authenticated signup, record consent separately, then execute each approved sync kind once within its supported window. Unknown outcome means STOP, never automatic retry.
5. **Rollout safety**: verify a recoverable fresh Neon restore point, exact full CI head and live primary inbound/outbound, Messenger and billing/followup safeguards. All secondary sending / AI and followups OFF until independently tested and approved.

## What this PR does NOT do
It does not make the live service QR-ready, connect the number, verify Meta app permission, create a production database backup, configure environment secrets, turn on a callback, run an importer, or request history. QR must not be scanned yet. Keep the next operations small and separate from primary live service.
