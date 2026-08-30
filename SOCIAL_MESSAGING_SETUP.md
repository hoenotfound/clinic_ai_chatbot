# Facebook Messenger and Instagram auto-reply setup

This integration keeps the existing WhatsApp webhook and WhatsApp transport separate.

- WhatsApp callback: `/webhook`
- Facebook Messenger and Instagram callback: `/meta-webhook`
- All three channels share the existing AI reply, lead scoring, human takeover, attention flags, conversation history, and Telegram alert logic.
- Automated follow-up scheduling remains WhatsApp-only for now.
- Staff text replies work for WhatsApp, Facebook, and Instagram.
- Staff image uploads and voice messages from the Inbox remain WhatsApp-only for now.

## Environment variables

Add these to Render in addition to the existing WhatsApp variables:

```text
META_APP_SECRET=your_meta_app_secret
META_VERIFY_TOKEN=choose_a_secret_verify_token

FACEBOOK_PAGE_ID=your_facebook_page_id
FACEBOOK_PAGE_ACCESS_TOKEN=your_page_access_token

INSTAGRAM_ACCOUNT_ID=your_instagram_professional_account_id
INSTAGRAM_ACCESS_TOKEN=your_instagram_access_token
```

You can enable only Facebook or only Instagram. The unused channel variables may stay empty.

## Facebook Messenger

1. Add Messenger to the Meta developer app that will manage the Facebook Page.
2. Generate a Page access token for the Page.
3. Make sure the app has the permissions Meta requires for Messenger. Sending needs `pages_messaging`; connecting the Page to webhook subscriptions also needs `pages_manage_metadata`.
4. Set the webhook callback URL to:

   `https://YOUR-DOMAIN/meta-webhook`

5. Use the same value as `META_VERIFY_TOKEN` for the webhook verify token.
6. Subscribe the Page to the `messages` webhook field and make sure the app is installed/subscribed on that Page.
7. Put the Page ID and Page access token into `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN`.

Messenger replies are customer-initiated. The customer must have messaged the Page and Meta's messaging-window rules still apply.

## Instagram

1. Use an Instagram Professional account, meaning Business or Creator.
2. Configure Instagram API with Instagram Login for the account in Meta's developer dashboard.
3. Generate an Instagram access token with `instagram_business_basic` and `instagram_business_manage_messages` for that account.
4. Set the webhook callback URL to:

   `https://YOUR-DOMAIN/meta-webhook`

5. Use the same `META_VERIFY_TOKEN` value as the webhook verify token.
6. Subscribe the Instagram account to the `messages` webhook field.
7. Put the professional account ID and token into `INSTAGRAM_ACCOUNT_ID` and `INSTAGRAM_ACCESS_TOKEN`.

Instagram replies are also customer-initiated. The customer must first message the professional account before the API can reply.

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

WhatsApp continues to use `whatsappService.js`. Facebook and Instagram never call the WhatsApp send functions.

## Current media behavior

Inbound Facebook/Instagram text, image, and audio events are accepted. Image and audio downloads are best-effort because Meta attachment URLs can be short-lived. If a media file cannot be downloaded, the conversation is flagged for staff and the customer gets a safe fallback reply.

The first-message promotional image is supported on all three channels using its public promo image URL.

For staff takeover, plain text replies are supported on all three channels. New staff image uploads and voice recordings in the Inbox remain WhatsApp-only until separate social-media upload flows are added.

## Deployment check

After adding the environment variables and webhook subscriptions:

1. deploy the branch;
2. message the Facebook Page from a normal Facebook account and confirm the message appears in Inbox with the Facebook badge;
3. message the Instagram Professional account from another Instagram account and confirm it appears with the Instagram badge;
4. confirm the AI replies on the same channel;
5. send a WhatsApp test message and confirm the existing WhatsApp reply, promo image, media handling, and delivery status still work.
