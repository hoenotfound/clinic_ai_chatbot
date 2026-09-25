# WhatsApp Business App Coexistence

This integration lets a business keep using the WhatsApp Business mobile app while the DA Chatbot uses the WhatsApp Cloud API on the same phone number.

## Runtime behavior

Coexistence is additive. Standard Cloud API clients keep the existing WhatsApp flow.

Set this only on a client whose number has completed the Meta WhatsApp Business App coexistence onboarding flow:

```env
WHATSAPP_COEXISTENCE_ENABLED=true
```

When a staff member sends a message from the WhatsApp Business app, Meta sends an `smb_message_echoes` webhook. DA Chatbot:

1. treats the event as a business/staff message, never a customer inbound;
2. cancels any in-flight AI turn for that customer;
3. switches the existing contact to Staff mode;
4. saves the message in the same Inbox conversation with `sent_by_username = "WhatsApp Business App"`;
5. uses the provider WAMID as the existing dedupe key;
6. marks the lead as contacted;
7. does not run AI, lead-temperature scoring, inbound follow-up logic, or customer-message automation for the echo.

Staff mode remains active until someone explicitly uses **Return to AI** in the Inbox.

## Race protection

There are three guards against a competing AI response:

- the echo is atomically deduplicated and persisted with `mode = 'human'` before the webhook is acknowledged;
- once that transaction confirms a genuinely new staff message, it invalidates the in-memory AI cancellation epoch;
- the AI path checks both the cancellation epoch and current contact ownership again immediately before the provider send.

The existing customer-message durability, typing burst, and ownership checks remain in place.

No application can revoke a provider request that has already crossed the network boundary. The important operational test is therefore that an app echo received before the Cloud API send begins suppresses that send.

## Webhook fields

For a coexistence WABA, configure the per-WABA callback with:

```text
messages
smb_message_echoes
smb_app_state_sync
history
```

The setup command supports this without changing the default behavior:

```bash
npm run whatsapp-webhook:configure -- \
  --client-url https://client.example.com \
  --runtime-env-file ./client-runtime.env \
  --coexistence
```

Do not use `--coexistence` on an ordinary Cloud API WABA unless the number is intentionally being prepared for coexistence.

## Status check

After coexistence onboarding, confirm the number is still active in both systems with the read-only command:

```bash
npm run whatsapp-coexistence:status -- \
  --runtime-env-file ./client-runtime.env
```

A ready result requires both `is_on_biz_app=true` and `platform_type=CLOUD_API`.
The command never registers or modifies the number and does not accept tokens as CLI arguments.

## History and app state sync

Meta currently requires the optional history/contact synchronization to be started within 24 hours of coexistence onboarding, and the history initiation can only be performed once for that onboarding session. This release recognizes and acknowledges `history` and `smb_app_state_sync` events, but deliberately does not initiate or import the synchronization into operational conversation tables.

That prevents old data from:

- triggering AI replies;
- creating duplicate customer messages;
- affecting lead temperature or pipeline automation;
- scheduling follow-ups;
- making old conversations appear as new unread leads.

A later history-import feature should use a dedicated import path with explicit historical flags instead of reusing the live inbound pipeline.

## Cloud API outbound messages

The coexistence parser only accepts the `smb_message_echoes` webhook field. Generic `message_echoes` events do not enter the Business App staff path, so a Cloud API-originated message cannot recursively trigger another AI reply through this integration.

Delivery/read statuses still use the existing `value.statuses` path.

## Current safe-release scope

Implemented:

- Business App text echo parsing;
- common media/unsupported echo placeholders in the Inbox;
- provider-message-ID dedupe;
- Staff-mode takeover;
- AI race suppression;
- Inbox realtime refresh;
- pipeline contacted state;
- coexistence webhook-field configuration;
- passive recognition of history and app-state sync;
- unchanged behavior for non-coexistence clients.

Intentionally deferred:

- importing historical conversations;
- importing Business App address-book/contact state;
- downloading and storing Business App echo media bytes;
- applying edit/revoke events to earlier stored messages;
- the customized Embedded Signup UI/flow required to start Business App coexistence onboarding;
- initiating Meta's one-time history/contact synchronization;
- automatic production-number migration.

## Go-live checks for a coexistence number

Before changing a client's production number:

1. Complete Meta's customized Embedded Signup flow for WhatsApp Business App coexistence.
2. Confirm the signup event is `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` and do not run the normal phone-number registration step.
3. Run `npm run whatsapp-coexistence:status -- --runtime-env-file <file>` and require `is_on_biz_app=true` plus `platform_type=CLOUD_API`.
4. Configure the client's runtime phone number/WABA credentials through the normal secret-management process.
5. Set `WHATSAPP_COEXISTENCE_ENABLED=true` only on that client.
6. Configure the per-WABA callback with `--coexistence`.
7. If history/contact sync is required, initiate it within Meta's 24-hour onboarding window using a dedicated import path before enabling operational automation.
8. Verify a normal customer inbound produces one AI reply.
9. Verify a Business App staff reply appears in the DA Inbox and switches the conversation to Staff mode.
10. Start an AI turn, reply from the Business App before it sends, and verify no Cloud API AI response is emitted.
11. Retry the same echo payload and verify there is only one stored staff message.
12. Verify Cloud API sends remain visible/deliver normally and do not recurse.
13. Verify the existing test-number client path and Facebook/Instagram tests remain green.

Do not point a live production number at this branch before the branch test suite and PR regression review pass.
