# WhatsApp Business App coexistence

This project supports WhatsApp Business App + Cloud API coexistence additively.
Normal Cloud API clients continue using the existing `messages` and `statuses`
webhook flow unchanged.

## Live staff messages

A message sent by staff from the WhatsApp Business app arrives as the
`smb_message_echoes` webhook field.

The client `/webhook` handler:

1. parses the echo separately from customer `messages`;
2. deduplicates it by Meta WAMID;
3. resolves the customer from the echo's `to` number;
4. switches the conversation to Staff mode before storing the message;
5. stores it as an outbound `assistant` message authored by
   `WhatsApp Business App`;
6. advances only a New lead to Contacted;
7. acknowledges Meta only after the live staff message and takeover are durable;
8. downloads supported image/audio media after the acknowledgement.

It never sends an AI reply for the echo.

The persistent Staff-mode transition is intentional. A Business App reply is a
real human intervention, so AI stays paused until staff explicitly returns the
conversation to AI.

## AI race protection

Customer inbound and AI generation keep using the existing durable inbound
queue and reply debounce.

If a Business App staff reply arrives while an AI reply is waiting in the
debounce window or being generated, the staff echo changes the contact to
`mode = 'human'`. The normal AI ownership guard reads the latest contact again
after generation, and the server performs a second ownership read immediately
before a normal AI send.

Once an outbound HTTP request has already been handed to Meta it cannot be
recalled, so there is necessarily a very small final network-call boundary.
The application checks ownership immediately before crossing that boundary.

## History sync

`history` webhooks are treated as imports, not new customer activity.

Imported rows are marked `is_history_import = true` and:

- are visible in Inbox history;
- preserve the provider message ID and provider timestamp;
- are deduplicated by WAMID;
- do not create a lead;
- do not set unread/attention state;
- do not enter Staff mode;
- do not trigger AI;
- are excluded from AI conversation context;
- are excluded from lead-scoring windows;
- are excluded from follow-up eligibility.

The sync is not initiated automatically by provisioning. Meta treats Business
App data synchronization as an onboarding operation, so triggering it must be
an explicit onboarding step.

## `smb_app_state_sync`

The Business App state sync mirrors the business owner's address book. This
implementation parses and accepts the event but deliberately does not create
CRM contacts/leads from address-book entries. Contacts are created only when
there is an actual live or imported conversation.

This avoids filling DA Chatbot Contacts/Pipeline with people who have never had
a conversation relevant to the chatbot.

## Webhook subscriptions

For a coexistence number the Meta app must be subscribed to the fields needed
for the flow:

- `messages` for normal customer inbound and delivery status callbacks;
- `smb_message_echoes` for Business App staff replies;
- `smb_app_state_sync` when contact-state synchronization is used;
- `history` when message-history synchronization is used.

These fields support WhatsApp callback overrides, so the existing per-WABA
`override_callback_uri` can continue routing the WABA directly to the client
`/webhook`.

Account-level fields such as `account_update` do not follow the WABA callback
override. If account lifecycle monitoring is added later, it belongs on the
shared app-level callback/router instead of each client WhatsApp webhook.

The existing `npm run whatsapp-webhook:configure` command remains responsible
only for the per-WABA callback override. It intentionally does not mutate the
shared Meta app's field subscriptions for every client.

## Read-only status check

After a number has gone through the actual Business App coexistence onboarding
flow, use the read-only command:

```powershell
npm run whatsapp-coexistence:status -- `
  --runtime-env-file .\<client>.client-runtime.env
```

A ready coexistence number should report:

- Business App: `yes`
- Platform: `CLOUD_API`
- Coexistence: `READY`

The command reads the token from the local runtime env file and never accepts or
prints it as a CLI argument.

## Business App data sync API helper

`src/services/whatsappCoexistenceApi.js` exposes
`requestBusinessAppDataSync()` for the two explicit onboarding sync types:

- `smb_app_state_sync`
- `history`

There is intentionally no provisioning command that invokes these automatically.

## Neutro Sense rollout guard

Do not replace the current test Phone Number ID or configure Neutro's live
number until all of the following are true:

1. this coexistence branch is merged and deployed;
2. the database migration has applied successfully;
3. automated tests and existing regression tests are green;
4. the shared Meta app is subscribed to the required coexistence webhook fields;
5. the live number completes Meta's Business App coexistence onboarding;
6. the read-only status command reports coexistence READY;
7. Neutro's live WABA callback override is then pointed at the Neutro
   `/webhook`;
8. controlled tests prove customer inbound, Business App staff reply, race
   suppression, retry dedupe and Cloud API outbound behavior before AI is
   allowed to operate normally.
