# Facebook Messenger and Instagram auto-reply setup

This integration keeps the existing WhatsApp webhook and WhatsApp transport separate.

- WhatsApp callback: `/webhook`
- Facebook Messenger and Instagram callback: `/meta-webhook`
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

## Environment variables

Add these to Render in addition to the existing WhatsApp variables:

```text
META_APP_SECRET=your_meta_app_secret
META_VERIFY_TOKEN=choose_a_secret_verify_token

FACEBOOK_PAGE_ID=your_facebook_page_id
FACEBOOK_PAGE_ACCESS_TOKEN=your_page_access_token

INSTAGRAM_PAGE_ID=the_facebook_page_id_linked_to_instagram
INSTAGRAM_PAGE_ACCESS_TOKEN=the_page_access_token_generated_in_instagram_settings
```

`META_APP_SECRET` is the app secret from **App Settings > Basic**. The shared `/meta-webhook` uses it to verify `X-Hub-Signature-256` for both Facebook and Instagram webhook POSTs.

A separate `INSTAGRAM_APP_SECRET` is not required by this integration.

You can enable only Facebook or only Instagram. The unused channel variables may stay empty.

## Facebook Messenger

1. Add/configure **Messenger from Meta** for the Facebook Page.
2. Generate a Page access token for the Page.
3. Make sure the app has the permissions/tasks Meta requires for Messenger, including permission to message as the Page.
4. Set the webhook callback URL to:

   `https://YOUR-DOMAIN/meta-webhook`

5. Use the same value as `META_VERIFY_TOKEN` for the webhook verify token.
6. Subscribe the Page to the `messages` webhook field and make sure the app is installed/subscribed on that Page.
7. Put the Page ID and Page access token into `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN`.

Messenger replies are customer-initiated. The customer must have messaged the Page and Meta's messaging-window rules still apply.

## Instagram Messaging

1. Connect an Instagram Professional account (Business or Creator) to the Facebook Page you will use for Instagram Messaging.
2. In the Meta developer app, open **Messenger from Meta > Instagram settings**.
3. Add the Page if it is not already listed.
4. Click **Generate token** beside that Page. This generates the **Page access token** used by this project.
5. Make sure the app/Page has the Instagram messaging permissions and tasks shown by Meta for this use case (including permission to manage/access Instagram messages).
6. Set the webhook callback URL to:

   `https://YOUR-DOMAIN/meta-webhook`

7. Use the same `META_VERIFY_TOKEN` value as the webhook verify token.
8. Subscribe the Instagram messaging webhook fields required by your app, including `messages`.
9. Put the **Facebook Page ID shown in Instagram settings** into `INSTAGRAM_PAGE_ID`.
10. Put the generated Page token into `INSTAGRAM_PAGE_ACCESS_TOKEN`.

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

Set `META_APP_SECRET` in production. The `/meta-webhook` POST route verifies Meta's `X-Hub-Signature-256` signature separately from the existing WhatsApp webhook verification.

The existing WhatsApp settings remain unchanged:

```text
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
```

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

1. deploy the branch;
2. message the Facebook Page from a normal Facebook account and confirm the message appears in Inbox with the Facebook badge;
3. message the Instagram Professional account from an Instagram test/app-role account and confirm it appears with the Instagram badge;
4. confirm the AI replies on Instagram and the message is accepted by Meta;
5. take over the Instagram conversation in Inbox and send a staff text reply;
6. send a WhatsApp test message and confirm the existing WhatsApp reply, promo image, media handling, and delivery status still work.
