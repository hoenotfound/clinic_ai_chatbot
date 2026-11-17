# Independent source-only recovery rehearsal

This preparation does not authorize a production pause or database switch.
Production is pinned to ac3f8b281b9f3643504c9a9214af931f7a080a35. Do not deploy the
head of this branch. Its checkout is for the external controller only.

## What this resolves

The earlier manual rehearsal paused production for 38 minutes 30 seconds when
browser control was interrupted. The new controller arms on GitHub Actions before
the operator signals the existing drain. After three consecutive clean drain
observations it deploys the worker-free holding command, verifies that deployment,
and immediately restores the pinned source application. No further browser click
or approval is needed while the service is held.

It changes only the start command and requests two commit-pinned deployments. It
cannot change DATABASE_URL, copy data, release holds or send test messages. It
refuses a destination database, a changed initial deployment, unknown start
command, multiple instances, automatic deployments, or overlapping deployment.
The rehearsal must never overlap a database copy or any destination activation.
All other operators and automation must leave this service unchanged during it.

The controller expires without changes if no pause starts within 120 seconds.
It allows 120 seconds for draining, requires three clean samples, and allows
180 seconds for the holding deployment. Recovery starts immediately after holding
is verified and has its own 15-minute monitoring deadline. Normal deployment
latency observed previously was about one minute per deployment, so the planning
target is 3–5 minutes of interruption. This is not a guaranteed outage limit.

The runner continues if the browser disconnects. It is not a highly available
recovery system: runner loss, Render outage, uncertain mutation responses, an
unsettled send or changed configuration can still require operator intervention.
An ambiguous deployment POST is never retried. A failed holding deployment can
restore the original fully drained source when its identity and absence of active
deployments are verified. Never force retirement when active work cannot settle.
A bounded monitor is not proof of bounded provider recovery time.

The metadata journal records each transition before mutation and is also printed
to the GitHub job log. The workflow retains its JSON artifact. Neither contains
credentials, message content, contact IDs or phone numbers.

## Concrete rehearsal after approval

1. Recheck the live deployment, source DB identity and original code. Confirm no
   pending deployment. Keep DATABASE_URL unchanged and permit no database copy.
2. Dispatch the manual source-only rehearsal on main, supplying the exact live
   source deployment and the explicit approval phrase. Approve only this protected
   environment run. Wait for its `armed` log before any signal.
3. In the current Render shell, verify two fresh private drain-status heartbeats,
   enabled/running state and the current PID's actual command. Signal SIGUSR2 to
   that exact application PID. Do not reuse a PID from an earlier deploy.
4. Let the independent runner perform holding and restoration. Do not cancel it,
   change Render settings, launch a second deployment or start a copy.
5. Verify source_deploy_live and rehearsal_complete, then confirm source identity,
   workers, recent inbound jobs, receipts, protected unknown holds and queue age.
   Verify the current root is normal, not migration_hold or migration_draining.
6. Record actual timing. No test messages go to customers. Natural traffic may
   provide evidence for both numbers; absent traffic must be marked unobserved.

## Message preservation evidence and limits

Official WhatsApp documentation says non-200 webhook delivery is retried for up
to seven days and duplicates are possible:
https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview

Read-only production evidence on November 17 identified a secondary WhatsApp
message with provider timestamp November 16 15:27:59 UTC, during the old pause.
It was stored November 16 16:23:07 UTC, after recovery at 15:59:44, and its inbound
job completed at 16:23:11, attempt 1. Exactly one message row has that provider ID.
No content or customer identity is reproduced here. This supports delayed delivery
for that one message. It does not prove every lost-delivery scenario, the primary
number or Messenger. The 23-minute delay after recovery is operationally relevant.

Local HTTP tests verify retry responses for both WhatsApp routes, direct social
callbacks and staff writes, no false acknowledgement for mixed batches, signature
validation and continued forwarding of other clients. Existing durable inbound
jobs retain acknowledged work. No application-owned queue was added in front of
the holding process. A provider retry policy is not a complete inventory of events
that never reached the endpoint.

## Final synchronization gate

After rehearsal, final migration still requires a controller that owns the copy
and activation phase, including stopping copy work before any source recovery.
Do not run this source-only rehearsal watcher around a manually operated final
copy. A blind source restart could invalidate the snapshot or create two writers.

The final controller needs secure destination access on the trusted runner and
must demonstrate these states before final approval:

- source authoritative, ingress retrying, all tracked work drained;
- old instance retired and no unexplained source clients;
- final archive stored, empty destination restored, all table digests/schema/
  sequences verified, source checked again including sequence-only changes;
- explicit irreversible authority boundary before destination activation;
- one destination worker instance; no automatic return to stale source afterward.

A backup made while source remains live is recoverable but not a final sync.
After destination writes, prefer a compatible code rollback retaining destination.
A database rollback requires another clean drain and a complete verified reverse
copy into a new rollback database, retaining receipts, consent, appointments,
follow-up completion and uncertain billing state. Never reset unknown sends.

## Latest read-only data check

November 17 08:54 UTC (17:54 Korea):

| Item | Source | Initial destination |
|---|---:|---:|
| Application tables | 115 | 115 |
| Contacts | 8,371 | 8,335 |
| Messages | 19,931 | 19,548 |
| Provider receipts | 5,502 | 4,852 |
| Migration records | 133 | 133 |

Both sender IDs/account mappings remain equal and active. Production has six
unknown billing attempts, four unknown gates, and no open inbound or receipt jobs
at the later sample. Both saved archives were re-hashed in the database and match
their stored SHA-256 values. These checks do not refresh the stale destination.

## Validation

68 local tests passed with zero failures or skips, including real local HTTP and
process-signal tests. Controller API mutations are mocked. No live rehearsal,
production deployment, pause, database switch, plan change or customer send was
performed by this preparation.
