# Facebook Messenger and Instagram auto-reply setup

This integration keeps the existing WhatsApp webhook and WhatsApp transport separate.

- WhatsApp callback: `/webhook`
- Per-client Facebook Messenger and Instagram processing endpoint: `/meta-webhook`
- Shared multi-client Meta callback: central router (embedded or standalone; see below)
- All three channels share the existing AI reply, lead scoring, human takeover, attention flags, conversation history, and Telegram alert logic.
- Automated follow-up scheduling remains WhatsApp-only for now.
- Staff text replies work for WhatsApp, Facebook, and Instagram.
- Staff image uploads and voice messages from the Inbox remain WhatsApp-only for now.

## Meta app model used by this project

Facebook Messenger and Instagram Messaging are configured through **Messenger from Meta** in the same Meta developer app.

Instagram therefore uses the **Facebook Page linked to the Instagram Professional account** and a **Page access token** generated from:

`Meta Developers > Messenger from Meta > Instagram settings > Access tokens`

The project deliberately does not use the separate "Instagram API with Instagram Login" token flow. Do not paste an Instagram authorization code into the server configuration.

Both Facebook and Instagram API calls use `graph.facebook.com`. Instagram replies are sent to the Instagram-scoped user ID (IGSID) received in the webhook, through `/{PAGE_ID}/messages`.

## Single-client vs multi-client callbacks

A single-client deployment can point Messenger and Instagram directly at that deployment's `/meta-webhook`.

When **one approved Meta Developer App is shared by several client businesses**, use the central router from `docs/multi-client-meta-routing.md` instead:

```text
Meta app-level Messenger + Instagram callback
  -> central Meta router
  -> identify Page / Instagram Professional Account
  -> isolate entries for one client
  -> sign isolated payload
  -> that client's /meta-webhook
```

For the cost-saving bootstrap architecture, the router can be embedded in one existing always-on paid client Render:

```text
https://ANCHOR-CLIENT-DOMAIN/meta-router/meta-webhook
```

Only that anchor deployment sets:

```text
META_ROUTER_ENABLED=true
META_ROUTER_DATABASE_URL=<read-only routing DB credential>
```

The embedded router health endpoint is:

```text
https://ANCHOR-CLIENT-DOMAIN/meta-router/healthz
```

Later, the exact same router can be extracted to a dedicated service using `npm run meta-router:start`, where the callback is:

```text
https://YOUR-META-ROUTER/meta-webhook
```

Do not change the app-level Messenger/Instagram callback for every new client. Configure it once to the current central router and register each client's asset IDs in the routing registry.

WhatsApp is different: each client's WABA can use its own `override_callback_uri` and continue going directly to that client's `/webhook`. WhatsApp never needs to pass through the central Messenger/Instagram router.

## Environment variables

Add these to a client Render deployment in addition to the existing WhatsApp variables:

```text
META_APP_SECRET=your_shared_meta_app_secret
META_VERIFY_TOKEN=choose_a_secret_verify_token

FACEBOOK_PAGE_ID=your_facebook_page_id
FACEBOOK_PAGE_ACCESS_TOKEN=your_page_access_token

INSTAGRAM_PAGE_ID=the_facebook_page_id_linked_to_instagram
INSTAGRAM_PAGE_ACCESS_TOKEN=the_page_access_token_generated_in_instagram_settings
INSTAGRAM_ACCOUNT_ID=the_instagram_professional_account_id
```

`META_APP_SECRET` is the app secret from **App Settings > Basic**. The client `/meta-webhook` verifies `X-Hub-Signature-256` for both Facebook and Instagram webhook POSTs. In multi-client mode the central router verifies Meta's original signature first, isolates the entries for that client, and signs the exact isolated bytes with the same app secret before forwarding.

`INSTAGRAM_ACCOUNT_ID` is the Instagram Professional Account ID used as the incoming webhook routing identity. It is separate from `INSTAGRAM_PAGE_ID`, which remains the linked Facebook Page ID used by this project's outgoing Instagram Messenger API calls.

A separate `INSTAGRAM_APP_SECRET` is not required by this integration.

You can enable only Facebook or only Instagram. The unused channel variables may stay empty.

### Extra values for the temporary anchor/router deployment

Only the paid client Render chosen to host the bootstrap router needs:

```text
META_ROUTER_ENABLED=true
META_ROUTER_DATABASE_URL=<router-only PostgreSQL credential>
# Optional; defaults to /meta-router
META_ROUTER_MOUNT_PATH=/meta-router
```

`META_ROUTER_DATABASE_URL` should ideally be a PostgreSQL role with `SELECT` access to `meta_webhook_routes` only. Embedded mode intentionally refuses to use `OPS_DATABASE_URL`, so the customer deployment does not need the full Ops Registry database credential.

The live router does not run Ops Registry migrations or perform route-registration writes. The Ops Registry/operator tooling owns those control-plane operations.

## Facebook Messenger

1. Add/configure **Messenger from Meta** for the Facebook Page.
2. Generate a Page access token for the Page.
3. Make sure the app has the permissions/tasks Meta requires for Messenger, including permission to message as the Page.
4. Configure the webhook callback:
   - single-client app: `https://YOUR-CLIENT-DOMAIN/meta-webhook`
   - shared app, embedded router: `https://ANCHOR-CLIENT-DOMAIN/meta-router/meta-webhook`
   - shared app, standalone router: `https://YOUR-META-ROUTER/meta-webhook`
5. Use the corresponding `META_VERIFY_TOKEN` for the webhook verify token.
6. Subscribe the Page to the `messages` webhook field and make sure the shared app is installed/subscribed on that Page. App-level callback configuration alone is not enough for a new Page.
7. Put the Page ID and Page access token into `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN`.
8. In multi-client mode, register the Page ID in the central router for this client.

Messenger replies are customer-initiated. The customer must have messaged the Page and Meta's messaging-window rules still apply.

## Instagram Messaging

1. Connect an Instagram Professional account (Business or Creator) to the Facebook Page you will use for Instagram Messaging.
2. In the Meta developer app, open **Messenger from Meta > Instagram settings**.
3. Add the Page if it is not already listed.
4. Click **Generate token** beside that Page. This generates the **Page access token** used by this project.
5. Make sure the app/Page has the Instagram messaging permissions and tasks shown by Meta for this use case (including permission to manage/access Instagram messages).
6. Configure the webhook callback:
   - single-client app: `https://YOUR-CLIENT-DOMAIN/meta-webhook`
   - shared app, embedded router: `https://ANCHOR-CLIENT-DOMAIN/meta-router/meta-webhook`
   - shared app, standalone router: `https://YOUR-META-ROUTER/meta-webhook`
7. Use the corresponding `META_VERIFY_TOKEN` value as the webhook verify token.
8. Subscribe the Instagram messaging webhook fields required by your app, including `messages`, and ensure that this client's account/Page is actually connected to the shared app.
9. Put the **Facebook Page ID shown in Instagram settings** into `INSTAGRAM_PAGE_ID`.
10. Put the generated Page token into `INSTAGRAM_PAGE_ACCESS_TOKEN`.
11. Put the Instagram Professional Account ID into `INSTAGRAM_ACCOUNT_ID`.
12. In multi-client mode, register that Instagram Account ID in the central router for this client.

Do not use:

- an Instagram Login authorization code;
- an Instagram User access token from the separate Instagram Login flow;
- `graph.instagram.com` for this project's messaging transport.

For this setup, outgoing Instagram replies use:

```text
POST https://graph.facebook.com/v26.0/{INSTAGRAM_PAGE_ID}/messages
Authorization: Bearer {INSTAGRAM_PAGE_ACCESS_TOKEN}
```

The `recipient.id` is the Instagram-scoped user ID (IGSID) received as `sender.id` when that person messages the Professional account.

Instagram replies are customer-initiated. The customer must first message the Professional account before the API can reply.

## Security

Set `META_APP_SECRET` in production. The per-client `/meta-webhook` POST route verifies `X-Hub-Signature-256` separately from the existing WhatsApp webhook verification.

For multi-client routing, the central router never forwards another client's `entry[]` data to a client deployment. It verifies Meta's original request, splits the payload by registered asset ID, and only forwards the matching entries. The client-side asset filter remains as an additional guard.

The existing WhatsApp settings remain:

```text
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_WABA_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
```

`WHATSAPP_WABA_ID` is used by the manual multi-client onboarding command that configures a WABA-specific callback override. It is not required by the normal message-send path.

## What happens when a message arrives

Facebook and Instagram webhook events are normalized into the same internal message shape used by the current AI flow. The system then:

1. creates or finds the channel-specific contact;
2. saves the inbound message before doing AI work;
3. ignores webhook retries and outgoing message echoes;
4. applies the same lead and attention logic;
5. checks whether staff has taken over;
6. generates the reply using the existing AI service;
7. sends the reply through the correct channel transport.

WhatsApp continues to use `whatsappService.js`. Facebook and Instagram use the shared Meta messaging service and never call the WhatsApp send functions.

## Current media behavior

Inbound Facebook/Instagram text, image, and audio events are accepted. Image and audio downloads are best-effort because Meta attachment URLs can be short-lived. If a media file cannot be downloaded, the conversation is flagged for staff and the customer gets a safe fallback reply.

The first-message promotional image is supported on all three channels using its public promo image URL.

For staff takeover, plain text replies are supported on all three channels. New staff image uploads and voice recordings in the Inbox remain WhatsApp-only until separate social-media upload flows are added.

## Deployment check

After adding the environment variables and webhook subscriptions:

1. deploy each client and enable the central Meta router in either embedded or standalone mode;
2. confirm the relevant router health endpoint is healthy;
3. confirm Messenger and Instagram app-level callbacks verify against the router;
4. confirm each client's Page/Instagram account is subscribed to the required webhook fields and registered in the routing table;
5. message the Facebook Page from a normal Facebook account and confirm the message appears only in the intended client's Inbox with the Facebook badge;
6. message the Instagram Professional account and confirm it appears only in the intended client's Inbox with the Instagram badge;
7. confirm the AI replies on Instagram and the message is accepted by Meta;
8. take over the Instagram conversation in Inbox and send a staff text reply;
9. configure/read back each WABA callback override and send a WhatsApp test message to confirm the existing reply, promo image, media handling, and delivery status still work;
10. repeat the real inbound/outbound checks for every purchased channel before enabling the client's Go-Live Gate.
