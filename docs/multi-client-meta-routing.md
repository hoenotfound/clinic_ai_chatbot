# Multi-client Meta messaging routing

This design keeps the production model where each client has its own Render service, Neon database, and optional private R2 bucket while one approved Meta Developer App is shared across many client businesses.

## Architecture

```text
one approved Meta Developer App
  |
  +-- WhatsApp
  |    each client WABA uses its own override_callback_uri
  |    -> that client's /webhook
  |
  +-- Messenger + Instagram
       one app-level callback -> central Meta router
         -> verify Meta X-Hub-Signature-256 on the original request
         -> resolve each entry.id to a client route
         -> split multi-business batches before forwarding
         -> sign each isolated client payload with the shared Meta app secret
         -> that client's /meta-webhook
         -> existing client signature verification + durable inbound processing
```

A client deployment never needs to receive another client's Messenger or Instagram entry. If Meta batches several business assets in one POST, the router verifies the original request once, groups entries by client target, creates a separate payload for each target, and signs the exact bytes it forwards. The existing `/meta-webhook` signature middleware therefore remains unchanged.

The runtime isolation preload is retained as defense in depth:

- Facebook routing identity: `FACEBOOK_PAGE_ID`
- Instagram routing identity: `INSTAGRAM_ACCOUNT_ID`

`INSTAGRAM_PAGE_ID` remains the linked Facebook Page ID used by the existing outbound Instagram Messenger API path. `INSTAGRAM_ACCOUNT_ID` is the Instagram Professional Account ID used as the webhook routing identity.

## Central Meta router deployment

Run the router as a separate Render web service from this repository:

```bash
npm run meta-router:start
```

Required router environment:

```text
META_APP_SECRET=<shared Meta Developer App secret>
META_VERIFY_TOKEN=<verify token configured in the Meta dashboard>
OPS_DATABASE_URL=<central Ops Registry PostgreSQL database>
```

Optional:

```text
META_ROUTER_FORWARD_TIMEOUT_MS=8000
```

Use `/healthz` as the router health check. Because Messenger and Instagram for every client depend on this service, deploy it as an always-available production service rather than a service that intentionally sleeps between requests.

Migration `004_meta_webhook_routes.sql` stores only route metadata: client slug, channel, Meta asset ID, target base URL, and enabled state. It does not store Page access tokens or the Meta app secret. One client can have multiple Facebook Pages and/or Instagram accounts. A given `(channel, asset_id)` can belong to only one client route.

Configure the app-level callbacks once:

```text
Messenger callback:
https://<meta-router-host>/meta-webhook

Instagram callback:
https://<meta-router-host>/meta-webhook
```

Use the same `META_VERIFY_TOKEN` configured on the router. The router implements the GET verification challenge for these app-level callbacks.

## Register Messenger / Instagram client routes

After the client's assets are authorized and subscribed to the shared Meta app, register their webhook routing identities:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --facebook-page-id 123456789 \
  --instagram-account-id 17841400000000000
```

Or read the IDs from a local runtime dotenv:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --runtime-env-file ./beleco.client-runtime.env
```

The runtime file can contain:

```text
FACEBOOK_PAGE_ID=123456789
INSTAGRAM_ACCOUNT_ID=17841400000000000
```

A client that bought only one channel only needs that channel's route. If a client owns several Pages or Instagram accounts, run the registration command again for each additional asset; registration is keyed by channel + asset ID and does not replace another asset belonging to the same client.

Route registration controls only where an incoming webhook is delivered. It does **not** grant Meta permissions or subscribe the client's Page/account to webhook fields. During manual onboarding you must still complete the normal Meta asset authorization/subscription steps for that client. In particular, Messenger needs the client Page subscribed to the shared app and the required webhook fields such as `messages`; Instagram must likewise be connected/subscribed according to the Messenger-from-Meta Instagram setup used by this project.

## WhatsApp per-client callback

WhatsApp stays direct from Meta to each client's existing `/webhook`; it does not pass through the Messenger/Instagram router. Meta officially supports a WABA-specific callback override on `/{WABA_ID}/subscribed_apps`.

For manual onboarding run:

```bash
npm run whatsapp-webhook:configure -- \
  --waba-id 111111111111111 \
  --app-id YOUR_SHARED_META_APP_ID \
  --client-url https://da-chatbot-beleco-clinic.onrender.com \
  --runtime-env-file ./beleco.client-runtime.env
```

The runtime dotenv must contain:

```text
WHATSAPP_TOKEN=...
WHATSAPP_VERIFY_TOKEN=...
```

It may also contain:

```text
WHATSAPP_WABA_ID=...
META_APP_ID=...
```

`WHATSAPP_WABA_ID` lets you omit `--waba-id`. `META_APP_ID` lets you omit `--app-id` while still confirming that the read-back subscription belongs to the intended shared app.

The command performs three checks/actions in order:

```text
1. GET the client /webhook with Meta-style hub.mode / hub.verify_token / hub.challenge
   -> fail before changing Meta if the Render URL or verify token is wrong
2. POST /{WABA_ID}/subscribed_apps
   override_callback_uri=https://client.example/webhook
   verify_token=<that client's WHATSAPP_VERIFY_TOKEN>
3. GET /{WABA_ID}/subscribed_apps?limit=100
   -> confirm the callback override, and the app ID when supplied
```

This makes the manual WABA step safe to repeat for many clients.

## Client runtime values

A Messenger client keeps its normal per-client credentials:

```text
FACEBOOK_PAGE_ID=...
FACEBOOK_PAGE_ACCESS_TOKEN=...
META_APP_SECRET=<shared app secret>
META_VERIFY_TOKEN=...
```

An Instagram client uses:

```text
INSTAGRAM_PAGE_ID=<linked Facebook Page ID used for sending>
INSTAGRAM_PAGE_ACCESS_TOKEN=...
INSTAGRAM_ACCOUNT_ID=<Instagram Professional Account ID used for routing/defense in depth>
META_APP_SECRET=<shared app secret>
META_VERIFY_TOKEN=...
```

The central router verifies Meta's original signature. It then signs each isolated client payload using the same app secret, so the existing client `verifyMetaWebhookSignature` middleware remains valid. `X-DA-Meta-Router: 1` is added for diagnostics.

## Failure behavior

The router waits until every affected client has durably accepted the routed webhook. If a route is missing, disabled, times out, or a client returns a non-2xx response, the router returns HTTP 503 to Meta instead of acknowledging undelivered work.

Meta can retry the original event. Existing provider-message-ID deduplication and durable inbound storage make those retries safe. A healthy client may receive its isolated event again when another client in the original Meta batch was unavailable, but it should not create a duplicate conversation message.

Unknown assets intentionally fail closed with 503. If an old Page/account is removed from service, unsubscribe that asset from the Meta app or remove/disable its delivery configuration instead of leaving a permanent unknown webhook source that Meta will keep retrying.

## Manual onboarding sequence

```text
1. Provision client Render + Neon + optional R2 using the existing PR129 flow
2. Give the client deployment its channel-specific tokens/IDs
3. Manually authorize/attach the client's Meta assets to the shared Meta app
4. Ensure the client's Messenger/Instagram assets are subscribed to the required webhook fields
5. Messenger/Instagram: register Page / Instagram account IDs in the central router
6. WhatsApp: configure and read-back the WABA callback override to that client's /webhook
7. Point the app-level Messenger + Instagram callbacks to the central router once (not once per client)
8. Run Setup Status plus real inbound and outbound go-live tests for every purchased channel
```

This flow deliberately does not require Embedded Signup. Embedded Signup can be added later to automate authorization while keeping the same runtime routing architecture.
