# Fleet Version and Deployment Drift

The central Ops Registry exposes read-only deployment-version visibility for every registered client. This is operational metadata only; it does not redeploy, upgrade, restart, or modify any client chatbot.

## What is compared

Each client already reports its running Render commit through the sanitized `/api/ops/readiness` deployment payload. The Registry treats that value as the **observed commit**.

The Registry compares the observed commit with one fleet target:

1. `OPS_FLEET_TARGET_COMMIT`, when explicitly configured on the Ops Registry; otherwise
2. the Registry service's own `RENDER_GIT_COMMIT` (or `OPS_REGISTRY_COMMIT` compatibility value).

`OPS_FLEET_TARGET_COMMIT` is useful when the Ops Registry is deployed ahead of the release you intentionally want client services to run. Set it to the full approved Git commit SHA. Removing it returns the target to the Registry deployment commit.

Comparisons are exact commit comparisons and are case-insensitive.

## Drift states

- `current` — a client has a successfully observed running commit and it exactly matches the fleet target.
- `drifted` — a client has a successfully observed running commit and it differs from the fleet target.
- `unknown` — the Registry has not observed a running commit yet, or no fleet target commit is available.

The Registry intentionally does **not** call a provisioned commit `current` unless that commit has actually been observed from the running client. Provisioning metadata is shown separately for diagnosis.

The Registry also reports whether the observed running commit differs from the commit recorded when that client was originally provisioned. This can reveal a later manual or automated deployment without treating the provisioning receipt as live proof.

## What the dashboard shows

The fleet dashboard shows:

- fleet target commit and whether it comes from a pinned target or the Registry deployment;
- count of Current, Drifted, and Unknown clients;
- each client's last observed commit and fleet target;
- the timestamp when that version was last successfully observed.

The client detail page additionally shows:

- observed commit;
- fleet target commit;
- target source;
- provisioned commit;
- whether the running commit changed since provisioning;
- Registry deployment commit;
- app version and process start time.

## Lifecycle interaction

Lifecycle behavior from the staging-aware polling policy is unchanged:

- `setup` and `trial` clients are not background-polled, so their version is the last version observed during enrollment or a manual **Refresh client** action;
- `live` clients are refreshed on the normal fleet interval;
- `paused` clients are not polled and cannot be manually refreshed until reactivated.

A sleeping Free Render client is therefore not woken merely to keep its version badge fresh.

## API compatibility

Existing `deployment.state` and `deployment.deployedCommit` fields remain for compatibility. New consumers should use:

```json
{
  "deployment": {
    "driftStatus": "current | drifted | unknown",
    "observedCommit": "...",
    "targetCommit": "...",
    "targetSource": "configured | registry_deployment | unavailable",
    "provisionedCommit": "...",
    "changedSinceProvisioning": true,
    "lastObservedAt": "..."
  }
}
```

`GET /api/clients` also includes `deploymentSummary` with the fleet target plus Current / Drifted / Unknown counts.

`POST /api/refresh-all` still polls only `live` clients, but its response returns the complete fleet snapshot after polling. This keeps setup/trial/paused clients visible to API consumers while avoiding network traffic to them.

## Deliberate limitation

This feature does not claim that a differing commit is "N commits behind" or determine ahead/behind/diverged ancestry. Doing that reliably for a private repository requires an explicit authenticated GitHub read integration. Until that is added, the Registry reports the truthful state as **Drifted** and shows both exact SHAs.
