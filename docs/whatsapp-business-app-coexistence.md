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

- the echo invalidates an in-memory cancellation epoch as soon as the signed webhook is parsed;
- the echo persists `mode = 'human'` before the webhook is acknowledged;
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

## History and app state sync

`history` and `smb_app_state_sync` events are recognized and acknowledged, but this release deliberately does not import them into operational conversation tables.

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
- a dedicated onboarding UI;
- automatic production-number migration.

## Go-live checks for a coexistence number

Before changing a client's production number:

1. Complete Meta's WhatsApp Business App coexistence onboarding for that number.
2. Confirm Meta reports the number as still on the Business App, including the current `is_on_biz_app` / platform status where available.
3. Configure the client's runtime phone number/WABA credentials through the normal secret-management process.
4. Set `WHATSAPP_COEXISTENCE_ENABLED=true` only on that client.
5. Configure the per-WABA callback with `--coexistence`.
6. Verify a normal customer inbound produces one AI reply.
7. Verify a Business App staff reply appears in the DA Inbox and switches the conversation to Staff mode.
8. Start an AI turn, reply from the Business App before it sends, and verify no Cloud API AI response is emitted.
9. Retry the same echo payload and verify there is only one stored staff message.
10. Verify Cloud API sends remain visible/deliver normally and do not recurse.
11. Verify the existing test-number client path and Facebook/Instagram tests remain green.

Do not point a live production number at this branch before the branch test suite and PR regression review pass.
