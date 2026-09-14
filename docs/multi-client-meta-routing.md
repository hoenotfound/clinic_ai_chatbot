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

## Recommended bootstrap deployment: embed the router in one paid client Render

For the first few customers, the central Meta router can run inside one existing always-on paid client Render instead of paying for another Render service.

```text
                         ONE META APP
                              |
             +----------------+----------------+
             |                                 |
         WhatsApp                       Messenger + IG
             |                                 |
      per-WABA direct                          v
        callbacks                    Anchor paid client Render
             |                        +-----------------------+
             |                        | normal chatbot        |
             |                        | /webhook              |
             |                        | /meta-webhook         |
             |                        |                       |
             |                        | embedded Meta router  |
             |                        | /meta-router/...      |
             |                        +-----------+-----------+
             |                                    |
       +-----+-----+                         +----+----+
       v     v     v                         v    v    v
     Client A/B/C Render                  Client A/B/C Render
```

Only the chosen anchor deployment sets:

```text
META_ROUTER_ENABLED=true
META_ROUTER_DATABASE_URL=<router DB credential>
META_APP_SECRET=<shared production Meta app secret>
META_VERIFY_TOKEN=<shared callback verification token>
```

Optional:

```text
META_ROUTER_MOUNT_PATH=/meta-router
META_ROUTER_FORWARD_TIMEOUT_MS=8000
META_ROUTER_DATABASE_SSL_REJECT_UNAUTHORIZED=true
META_ROUTER_DATABASE_CONNECTION_TIMEOUT_MS=5000
META_ROUTER_DATABASE_QUERY_TIMEOUT_MS=10000
META_ROUTER_DATABASE_POOL_MAX=3
```

The default embedded endpoints are:

```text
Callback verification + webhook:
https://<anchor-client-host>/meta-router/meta-webhook

Router health:
https://<anchor-client-host>/meta-router/healthz
```

Configure the shared Meta App's Messenger and Instagram callback URL once to the embedded callback above. Do not point WhatsApp at this route.

### Least-privilege database credential

Embedded mode deliberately refuses to fall back to `OPS_DATABASE_URL`. Do **not** put the full Ops Registry database credential on a customer deployment.

`META_ROUTER_DATABASE_URL` should ideally use a PostgreSQL role with only the access required by the live router:

```text
CONNECT to the routing database
USAGE on the schema containing meta_webhook_routes
SELECT on meta_webhook_routes
```

The live router does not run Ops migrations and does not register/update routes. Migration `004_meta_webhook_routes.sql` and route-registration writes remain control-plane operations run through the Ops Registry/operator tooling.

This is important when the Ops Registry itself is hosted on a free/sleeping service: Messenger/Instagram delivery does not call the Ops Registry HTTP service. The embedded router reads the routing table directly from PostgreSQL, so the Ops Registry web service may be asleep without interrupting messages.

## Long-term deployment: extract the router to its own service

The embedded mode is intentionally portable. When client volume justifies dedicated infrastructure, deploy the same router as its own Render service:

```bash
npm run meta-router:start
```

Use:

```text
META_ROUTER_DATABASE_URL=<router DB credential>
META_APP_SECRET=<shared Meta Developer App secret>
META_VERIFY_TOKEN=<verify token configured in the Meta dashboard>
```

Optional:

```text
META_ROUTER_FORWARD_TIMEOUT_MS=8000
```

The standalone service exposes:

```text
/meta-webhook
/healthz
```

At migration time, change the Meta App callback from:

```text
https://<anchor-client-host>/meta-router/meta-webhook
```

to:

```text
https://<dedicated-meta-router-host>/meta-webhook
```

No client Render/Neon architecture or route records need to change.

For a dedicated production router, keep it always available. Messenger and Instagram for every client depend on it. The router is deliberately read-only; ensure Ops migration `004_meta_webhook_routes.sql` has already been applied before starting it.

## Route registry

Migration `004_meta_webhook_routes.sql` stores only route metadata: client slug, channel, Meta asset ID, target base URL, and enabled state. It does not store Page access tokens or the Meta app secret. A given `(channel, asset_id)` can belong to only one client route, and each client deployment can register at most one Facebook Page and one Instagram account. That matches the chatbot runtime, which currently has one sender ID/access-token configuration per channel.

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

A client that bought only one channel only needs that channel's route. Re-running registration for the same client and the same asset is safe and can update the target URL/enabled state. Assigning a different Page or Instagram account to the same client/channel is rejected until the previous route is explicitly removed; this prevents inbound traffic for one asset from being answered with another asset's configured sender/token. If a business later needs multiple Pages or multiple Instagram accounts in one deployment, the outbound credential model must be expanded first rather than only adding router entries.

Route registration controls only where an incoming webhook is delivered. It does **not** grant Meta permissions or subscribe the client's Page/account to webhook fields. During manual onboarding you must still complete the normal Meta asset authorization/subscription steps for that client. In particular, Messenger needs the client Page subscribed to the shared app and the required webhook fields such as `messages`; Instagram must likewise be connected/subscribed according to the Messenger-from-Meta Instagram setup used by this project.

## WhatsApp remains direct per client

WhatsApp does not pass through the Messenger/Instagram router. Each WABA stays direct from Meta to its own client's existing `/webhook` using the WABA-specific callback override on `/{WABA_ID}/subscribed_apps`.

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

This makes the manual WABA step safe to repeat for many clients and keeps WhatsApp independent of the central FB/IG router.

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

Only the temporary anchor client additionally needs `META_ROUTER_ENABLED=true` and the router database credential. Other clients do not.

## Failure behavior

The router waits until every affected client has durably accepted the routed webhook. If a route is missing, disabled, times out, or a client returns a non-2xx response, the router returns HTTP 503 to Meta instead of acknowledging undelivered work.

Meta can retry the original event. Existing provider-message-ID deduplication and durable inbound storage make those retries safe. A healthy client may receive its isolated event again when another client in the original Meta batch was unavailable, but it should not create a duplicate conversation message.

Unknown assets intentionally fail closed with 503. If an old Page/account is removed from service, unsubscribe that asset from the Meta app or remove/disable its delivery configuration instead of leaving a permanent unknown webhook source that Meta will keep retrying.

## Bootstrap manual onboarding sequence

```text
1. Provision client Render + Neon + optional R2 using the existing PR129 flow
2. Give the client deployment its channel-specific tokens/IDs
3. Manually authorize/attach the client's Meta assets to the shared Meta app
4. Ensure the client's Messenger/Instagram assets are subscribed to required webhook fields
5. Messenger/Instagram: register Page / Instagram account IDs in the route registry
6. WhatsApp: configure and read back the WABA callback override to that client's /webhook
7. On the chosen paid anchor Render only:
   META_ROUTER_ENABLED=true
   META_ROUTER_DATABASE_URL=<read-only routing credential>
8. Point the app-level Messenger + Instagram callback once to:
   https://<anchor-host>/meta-router/meta-webhook
9. Verify /meta-router/healthz
10. Run Setup Status plus real inbound and outbound go-live tests for every purchased channel
```

This flow deliberately does not require Embedded Signup. Embedded Signup can be added later to automate authorization while keeping the same runtime routing architecture.
