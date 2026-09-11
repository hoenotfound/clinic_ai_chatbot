# Fleet Version and Deployment Drift

The central Ops Registry exposes read-only deployment-version visibility for every registered client. This is operational metadata only; it does not redeploy, upgrade, restart, or modify any client chatbot.

## What is compared

Each client already reports its running Render commit through the sanitized `/api/ops/readiness` deployment payload. The Registry treats that value as the **observed commit**.

The Registry compares the observed commit with one fleet target:

1. `OPS_FLEET_TARGET_COMMIT`, when explicitly configured on the Ops Registry; otherwise
2. the Registry service's own `RENDER_GIT_COMMIT` (or `OPS_REGISTRY_COMMIT` compatibility value).

`OPS_FLEET_TARGET_COMMIT` is useful when the Ops Registry is deployed ahead of the release you intentionally want client services to run. Set it to the full approved Git commit SHA. Removing it returns the target to the Registry deployment commit.

Only a full 40- or 64-character hexadecimal Git commit SHA is accepted as evidence for the new drift status. Short SHAs, branch names such as `main`, and malformed values are not compared. An explicitly configured invalid target fails `npm run ops-registry:verify` and the runtime dashboard reports version state as **Unknown** rather than incorrectly marking the fleet Drifted.

Comparisons are exact and case-insensitive. The Registry does not infer ancestry from the text of a SHA.

## Drift states

The dashboard deliberately uses the wording **Observed current** and **Observed drifted** because the result describes the latest successful observation, not a permanent guarantee about the running service.

- `current` — a valid observed running commit exactly matches the valid fleet target.
- `drifted` — a valid observed running commit differs from the valid fleet target.
- `unknown` — the Registry cannot make a trustworthy comparison.

`unknown` includes explicit reasons:

- fleet target unavailable;
- fleet target invalid;
- running commit not observed yet;
- client returned an invalid commit value.

The Registry intentionally does **not** call a provisioned commit `current` unless that commit has actually been observed from the running client. Provisioning metadata is shown separately for diagnosis.

The Registry also reports whether the observed running commit differs from the commit recorded when that client was originally provisioned. That comparison is only made when both values are valid full Git SHAs. This can reveal a later manual or automated deployment without treating the provisioning receipt as live proof.

## What the dashboard shows

The fleet dashboard shows:

- fleet target commit and whether it comes from a pinned target or the Registry deployment;
- target validity and a safe diagnostic when configuration is invalid;
- count of Observed current, Observed drifted, and Unknown clients;
- each client's last observed commit and fleet target;
- the reason an Unknown comparison could not be made.

The client detail page additionally shows:

- observed commit;
- fleet target commit;
- target source and validation state;
- drift reason;
- provisioned commit;
- whether the running commit changed since provisioning;
- Registry deployment commit;
- app version and process start time;
- timestamp of the last successful version observation.

## Lifecycle interaction

Lifecycle behavior from the staging-aware polling policy is unchanged:

- `setup` and `trial` clients are not background-polled, so their version is the last version observed during enrollment or a manual **Refresh client** action;
- `live` clients are refreshed on the normal fleet interval;
- `paused` clients are not polled and cannot be manually refreshed until reactivated.

A sleeping Free Render client is therefore not woken merely to keep its version badge fresh. The detail page explicitly warns that Setup/Trial/Paused version evidence is a last observed snapshot and may be stale by design.

## API compatibility

Existing `deployment.state` and `deployment.deployedCommit` fields remain for compatibility and keep their original comparison against the Registry deployment commit. They are not repurposed when `OPS_FLEET_TARGET_COMMIT` is pinned.

New consumers should use:

```json
{
  "deployment": {
    "driftStatus": "current | drifted | unknown",
    "driftReason": "matches_target | differs_from_target | target_unavailable | target_invalid | observation_unavailable | observation_invalid",
    "observedCommit": "...",
    "observedCommitValid": true,
    "targetCommit": "...",
    "targetSource": "configured | registry_deployment | unavailable",
    "targetValidity": "valid | invalid | unavailable",
    "targetError": null,
    "provisionedCommit": "...",
    "provisionedCommitValid": true,
    "changedSinceProvisioning": true,
    "lastObservedAt": "..."
  }
}
```

`GET /api/clients` also includes `deploymentSummary` with the fleet target, target validity, and Observed current / Observed drifted / Unknown counts.

`POST /api/refresh-all` still polls only `live` clients, but its response returns the complete fleet snapshot after polling. This keeps setup/trial/paused clients visible to API consumers while avoiding network traffic to them.

## Deliberate limitation

This feature does not claim that a differing commit is "N commits behind" or determine ahead/behind/diverged ancestry. Doing that reliably for a private repository requires an explicit authenticated GitHub read integration. Until that is added, the Registry reports only the exact evidence it has: **Observed current**, **Observed drifted**, or **Unknown**.
