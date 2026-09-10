# Ops Registry client lifecycle

The Ops Registry tracks an operator-owned lifecycle for each client deployment. The lifecycle controls Registry polling only. It does not change the client's Render compute plan, Neon plan, chatbot configuration, or messaging behavior.

## Lifecycle states

| Lifecycle | Intended use | Background polling | Manual client refresh |
| --- | --- | --- | --- |
| `setup` | Internal onboarding/configuration, including Free Render staging | Off | Allowed |
| `trial` | Customer demo/trial before production handover | Off | Allowed |
| `live` | Paying/production client | On, using `OPS_POLL_INTERVAL_MS` | Allowed |
| `paused` | Deliberately suspended monitoring | Off | Blocked until reactivated |

Newly registered or automatically enrolled clients default to `setup`. Existing Registry clients are migrated to `live` so this change does not silently disable monitoring for already-running production deployments.

## Recommended rollout

```text
Provision client
  -> lifecycle: setup
  -> Free/staging Render + Neon may sleep normally
  -> configure and test with manual Refresh client

Customer trial
  -> lifecycle: trial
  -> still no background polling
  -> manual Refresh client when testing

Customer accepts / production handover
  -> upgrade Render/Neon separately as required
  -> complete genuine purchased-channel Go-Live tests
  -> lifecycle: live
  -> normal background fleet monitoring begins

Temporarily stop monitoring
  -> lifecycle: paused
  -> no background or manual Registry polling until reactivated
```

Changing lifecycle never upgrades or downgrades hosting automatically. Upgrade the existing Render/Neon resources first, then move the Registry lifecycle to `live`.

## Operator UI

Open a client detail page in DA Chatbot Operations and use the Lifecycle selector. Lifecycle changes are protected by Ops admin authentication and the same `X-Ops-Action: 1` action guard used by refresh operations.

The fleet-level **Refresh live clients** action polls only `live` clients. It deliberately does not wake `setup`, `trial`, or `paused` deployments. Setup/trial clients can still be tested with the per-client **Refresh client** button. Paused clients must be changed to another lifecycle before a refresh is permitted.

## API

Authenticated lifecycle update:

```http
POST /api/clients/<client-slug>/lifecycle
X-Ops-Action: 1
Content-Type: application/json

{"lifecycleStatus":"trial"}
```

Accepted values are exactly `setup`, `trial`, `live`, and `paused`. Invalid values fail closed with HTTP 400. Unknown clients return 404.

Per-client refresh returns HTTP 409 while the client is `paused`.

## Free hosting note

The purpose of `setup` and `trial` is to avoid the Registry itself becoming periodic inbound traffic that keeps an otherwise idle staging service awake. The Registry still retains the last verified readiness snapshot while background monitoring is intentionally disabled. A failed manual refresh is still recorded as a current connectivity failure.
