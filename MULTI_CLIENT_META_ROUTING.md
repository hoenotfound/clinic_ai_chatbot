# Multi-client Meta messaging routing

This repository supports one Meta Developer App serving multiple isolated client deployments while keeping the existing deployment model:

```text
client A -> Render A -> Neon A -> R2 A
client B -> Render B -> Neon B -> R2 B
```

WhatsApp uses Meta's per-WABA callback override. Messenger and Instagram use one app-level callback that points to a small central router, which forwards each signed webhook to the correct client deployment.

## Architecture

```text
                         one Meta Developer App
                                  |
                 +----------------+----------------+
                 |                                 |
             WhatsApp                       Messenger / IG
                 |                                 |
       per-WABA callback override                  |
                 |                                 v
        +--------+--------+                 central Meta router
        |        |        |                 /meta-webhook
        v        v        v                        |
     Render A Render B Render C            route by asset ID
                                               /       \
                                              v         v
                                           Render A   Render B
```

The central Messenger/Instagram router verifies Meta's `X-Hub-Signature-256` against `META_APP_SECRET` before doing any routing. It forwards the exact original request bytes and original signature. Each client therefore keeps the existing `/meta-webhook` signature verification and does not trust unsigned router traffic.

When Meta sends several business entries in one signed request, the router forwards the original signed batch to each affected client. The client-side routing isolation layer filters the batch to that deployment's configured asset ID before the existing Messenger/Instagram parser or `message_edit` resolver processes it. This preserves Meta's signature while preventing cross-client message processing.

## 1. Deploy the central Messenger / Instagram router

Create one dedicated Render web service from this repository.

Use:

```text
Build command: npm ci
Start command: npm run meta-router:start
```

Required router environment variables:

```text
OPS_DATABASE_URL=<same central Ops Registry PostgreSQL database>
META_APP_SECRET=<Meta Developer App secret>
META_VERIFY_TOKEN=<verification token configured in Meta>
```

Optional:

```text
META_ROUTER_FORWARD_TIMEOUT_MS=8000
```

The router applies the existing Ops migrations on startup. Migration `004_meta_webhook_routes.sql` creates the routing table. The router also exposes:

```text
GET /healthz
```

After the router is live, set the app-level callback in Meta Developer Dashboard for both Messenger and Instagram to:

```text
https://<router-host>/meta-webhook
```

Use the same value from `META_VERIFY_TOKEN` when Meta asks for the verify token.

Do not point the app-level Messenger/Instagram callback at one client's Render service once multiple clients are using the same app.

## 2. Configure each Messenger client

Each client Render still keeps its own Page credentials:

```text
FACEBOOK_PAGE_ID=<client Facebook Page ID>
FACEBOOK_PAGE_ACCESS_TOKEN=<client Page access token>
META_APP_SECRET=<same Meta app secret>
META_VERIFY_TOKEN=<same app webhook verify token>
```

Register the Page route after the client Render service is live:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --facebook-page-id <FACEBOOK_PAGE_ID>
```

The router stores only the client slug, asset ID, target URL, and enabled state. It does not store Page access tokens or the Meta app secret in the routing table.

## 3. Configure each Instagram client

The existing Instagram sender configuration remains Page-linked:

```text
INSTAGRAM_PAGE_ID=<Facebook Page used by the Messenger Platform send endpoint>
INSTAGRAM_PAGE_ACCESS_TOKEN=<Page token with Instagram messaging access>
```

Multi-client webhook routing also needs the Instagram Professional Account ID because Instagram webhook `entry.id` is the routing identity:

```text
INSTAGRAM_ACCOUNT_ID=<Instagram Professional Account ID>
META_APP_SECRET=<same Meta app secret>
META_VERIFY_TOKEN=<same app webhook verify token>
```

Register it:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --instagram-account-id <INSTAGRAM_ACCOUNT_ID>
```

Messenger and Instagram routes can be registered together:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --facebook-page-id <FACEBOOK_PAGE_ID> \
  --instagram-account-id <INSTAGRAM_ACCOUNT_ID>
```

Or read those IDs from the same client runtime dotenv file used during manual onboarding:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --runtime-env-file ./beleco.client-runtime.env
```

## 4. Configure each WhatsApp client

WhatsApp does not need the central router. Keep each WABA pointed directly at that client's own Render service.

The client runtime/onboarding file should include:

```text
WHATSAPP_WABA_ID=<client WABA ID>
WHATSAPP_PHONE_NUMBER_ID=<client phone number ID>
WHATSAPP_TOKEN=<System User token with the required WhatsApp permissions>
WHATSAPP_APP_SECRET=<Meta app secret used for signed webhook verification>
WHATSAPP_VERIFY_TOKEN=<client webhook verify token>
```

The token used to manage the WABA subscription needs `whatsapp_business_management` access. Normal message sending still requires the existing WhatsApp messaging access.

After the client Render URL is live, run:

```bash
npm run whatsapp-webhook:configure -- \
  --client-url https://da-chatbot-beleco-clinic.onrender.com \
  --runtime-env-file ./beleco.client-runtime.env
```

The command sends:

```text
POST /<WABA_ID>/subscribed_apps
```

with that client's callback URL and verification token, then performs a follow-up `GET /<WABA_ID>/subscribed_apps` and fails unless Meta reports the expected `override_callback_uri`.

The app-level WhatsApp callback in Meta Developer Dashboard can remain as the default/fallback callback for WABAs without an override.

## 5. Recommended manual onboarding sequence

For the current manual Meta onboarding model:

```text
1. provision-client
2. wait for the client Render deployment to be live
3. attach the client's Meta assets and tokens
4. WhatsApp purchased?
   -> run whatsapp-webhook:configure
5. Messenger / Instagram purchased?
   -> run meta-router:register-client
6. confirm the Meta app-level Messenger/Instagram callback points to the central router
7. run real inbound/outbound tests for every purchased channel
8. use Setup Status / Go-Live Gate to confirm the normal chatbot flow
```

This does not require Embedded Signup.

## Reliability behavior

The router waits for the target client webhook to accept the request before returning HTTP 200 to Meta. If a target times out or returns a non-2xx response, the router returns 503 so Meta can retry the original webhook.

The client webhook continues to persist inbound work before acknowledging it. Existing message-ID deduplication makes retries safe.

If one Meta request contains entries for several client businesses and one client is temporarily unavailable, Meta may retry the entire request. Clients that already accepted it can safely see the same signed request again because the existing durable deduplication prevents duplicate customer messages.

## Security notes

- `META_APP_SECRET` is never stored in the routing table.
- Page/Instagram access tokens remain only on the relevant client deployment.
- The router database stores no Page or Instagram access token.
- The router forwards the exact signed Meta body rather than re-serializing JSON.
- Client-side filtering is applied before normal Messenger/Instagram message parsing.
- Do not omit `INSTAGRAM_ACCOUNT_ID` on a routed multi-client Instagram deployment.
- Keep the central router private from staff-facing application features. It should expose only its webhook and health endpoint.

## Disabling a route

A route can be deliberately disabled by re-registering it with `--disable`, for example:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --facebook-page-id <FACEBOOK_PAGE_ID> \
  --disable
```

A disabled or missing route fails closed. The router returns a retryable error rather than silently delivering the webhook to the wrong client.
