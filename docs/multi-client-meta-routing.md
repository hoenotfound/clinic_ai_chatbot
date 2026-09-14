# Multi-client Meta messaging routing

This design keeps the existing production model where each client has its own Render service, Neon database, and optional private R2 bucket while one approved Meta Developer App is shared across clients.

## Architecture

```text
one Meta Developer App
  -> WhatsApp: each WABA overrides its callback directly to that client's /webhook
  -> Messenger + Instagram: one app callback points to the central Meta router
       -> router verifies Meta's signature
       -> router finds the client by webhook entry asset ID
       -> router forwards the exact original signed body to that client's /meta-webhook
       -> client verifies the original Meta signature and processes only its own asset entry
```

The router intentionally forwards the exact raw request bytes. It does not parse and re-serialize the body before forwarding, so the existing client `X-Hub-Signature-256` verification remains valid.

If a Meta webhook contains entries for more than one business, the router sends the original signed request to every affected client. The runtime isolation preload then filters `entry[]` before the existing Messenger/Instagram parser runs:

- Facebook routing identity: `FACEBOOK_PAGE_ID`
- Instagram routing identity: `INSTAGRAM_ACCOUNT_ID`

`INSTAGRAM_PAGE_ID` remains the linked Facebook Page ID used by the existing outbound Instagram Messenger API path. `INSTAGRAM_ACCOUNT_ID` is separate and is used only to identify Instagram webhook entries for the correct client.

Older single-client Instagram deployments that do not yet have `INSTAGRAM_ACCOUNT_ID` keep their previous behavior. Add the routing ID before placing that deployment behind the shared router.

## Central Meta router deployment

Run the router as a separate Render web service from this repository:

```bash
npm run meta-router:start
```

Required router environment:

```text
META_APP_SECRET=<the shared Meta Developer App secret>
META_VERIFY_TOKEN=<the verification token used in the Meta dashboard>
OPS_DATABASE_URL=<the existing central Ops Registry PostgreSQL database>
```

Optional:

```text
META_ROUTER_FORWARD_TIMEOUT_MS=8000
```

The router uses the existing Ops migration system. Migration `004_meta_webhook_routes.sql` creates a routing table containing only client slug, channel, Meta asset ID, target base URL, and enabled state. It does not store Page access tokens or the Meta app secret.

Configure both Meta dashboard callbacks to the router:

```text
Messenger callback:
https://<meta-router-host>/meta-webhook

Instagram callback:
https://<meta-router-host>/meta-webhook
```

Use the same `META_VERIFY_TOKEN` that is configured on the router.

## Register a Messenger / Instagram client route

After the client's Page and Instagram account are manually attached to the shared Meta app, register its routing identity:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --facebook-page-id 123456789 \
  --instagram-account-id 17841400000000000
```

Or read the IDs from the same local runtime dotenv used during provisioning:

```bash
npm run meta-router:register-client -- \
  --client beleco-clinic \
  --url https://da-chatbot-beleco-clinic.onrender.com \
  --runtime-env-file ./beleco.client-runtime.env
```

For this second form the runtime file can contain:

```text
FACEBOOK_PAGE_ID=123456789
INSTAGRAM_ACCOUNT_ID=17841400000000000
```

A client that bought only one social channel only needs that one route.

## WhatsApp per-client callback

WhatsApp stays direct and does not pass through the Messenger/Instagram router.

For manual onboarding, keep the WABA ID available to the operator and run:

```bash
npm run whatsapp-webhook:configure -- \
  --waba-id 111111111111111 \
  --client-url https://da-chatbot-beleco-clinic.onrender.com \
  --runtime-env-file ./beleco.client-runtime.env
```

The runtime dotenv must contain:

```text
WHATSAPP_TOKEN=...
WHATSAPP_VERIFY_TOKEN=...
```

It may also contain `WHATSAPP_WABA_ID`, in which case `--waba-id` can be omitted.

The command subscribes the shared Meta app to that WABA with:

```text
override_callback_uri=https://da-chatbot-beleco-clinic.onrender.com/webhook
verify_token=<that client's WHATSAPP_VERIFY_TOKEN>
```

It then reads the WABA subscriptions back and fails unless the callback override is confirmed.

## Client runtime values

A routed Messenger client keeps its existing values:

```text
FACEBOOK_PAGE_ID=...
FACEBOOK_PAGE_ACCESS_TOKEN=...
META_APP_SECRET=...
META_VERIFY_TOKEN=...
```

A routed Instagram client uses:

```text
INSTAGRAM_PAGE_ID=<linked Facebook Page ID used for sending>
INSTAGRAM_PAGE_ACCESS_TOKEN=...
INSTAGRAM_ACCOUNT_ID=<Instagram Professional Account ID used for routing>
META_APP_SECRET=...
META_VERIFY_TOKEN=...
```

The client still verifies Meta's original signature because the router preserves the original signed request bytes. This keeps the current `/meta-webhook` handler unchanged.

## Failure behavior

The router waits until every affected client has acknowledged the webhook. If a route is missing, disabled, times out, or the client returns a non-2xx response, the router returns HTTP 503 to Meta instead of acknowledging undelivered work.

Meta may then retry the original event. Existing durable inbound storage and provider message-ID deduplication in each client deployment make those retries safe. A healthy client may see the retry again when another client in the same Meta batch was unavailable, but it should not create a duplicate conversation message.

## Manual onboarding sequence

```text
1. Provision client Render + Neon + R2 using the existing PR129 flow
2. Manually attach the client's Meta assets to the shared Meta app
3. WhatsApp: configure the WABA callback override to the client /webhook
4. Messenger/Instagram: register Page / Instagram account IDs in the central router
5. Point the app-level Messenger and Instagram callbacks to the central router once
6. Run the existing Setup Status and real inbound/outbound go-live tests
```

This does not require Embedded Signup. Embedded Signup can be added later to automate asset authorization, while the runtime routing model can remain the same.
