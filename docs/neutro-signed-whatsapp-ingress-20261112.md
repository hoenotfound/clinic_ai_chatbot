# Neutro WhatsApp signed-ingress diagnostics (12 November 2026)

## Goal

Distinguish a signed Meta webhook that reached the server but was rejected
locally from one for which no local delivery evidence exists. This is motivated
by the Nov 11 BSUID delays and the paid receiver HTTP 503 activation-gate
incident. A missing Inbox message alone does not establish Meta fault.

This change is read-only. No subscription, callback, AI, billing, outbound
sending, or provider retry behavior changes.

## Controlled rollout

1. Review CI and merge the PR when approved.
2. Deploy Neutro Render in a single controlled release.
3. Set WHATSAPP_WEBHOOK_INGRESS_DIAGNOSTICS_ENABLED=true only on Neutro.
   The default is OFF. Restart the service for the setting.
4. Filter Render application logs for [WhatsApp signed ingress].
5. To stop the additional logging, disable the flag and redeploy.
   There is no database migration or separate hosted service.

The secondary Meta app-default URL intentionally ends in
/whatsapp/default. Its verified receiver forwards legitimate secondary
customer callbacks to the existing /webhook handler internally. Do not
change the URL to install these diagnostics.

## Safe fields

- route: primary endpoint or app-default endpoint, never a full URL.
- signature: verified or not_verified. Unsigned requests NEVER expose
  customer-event metadata in the diagnostic line.
- phase: request, signature_verified, payload_parsed, sender_routed,
  durable_claim, or receiver_exception.
- httpStatus: actual HTTP status, including 503 local rejection.
- reason: controlled category such as receiver_config, sender_identity,
  unauthorized_batch, signature_proof, storage_timeout, receiver_exception.
- senderKinds: primary, secondary, known_account_wrong_or_missing_phone,
  or foreign_or_unknown, using BOTH account and phone evidence.
- identityKinds: BSUID-only, phone-and-user-ID, phone, missing, unrecognized.
- adReferrals: count of signed ad referral events, not ad IDs.
- ageBuckets / maxAgeSeconds: original Meta message age at server parsing.
- providerRefs: up to eight SHA256 20-hex-character prefixes of provider
  message/status IDs, never the original WAMID.
- claimAttempts and claimsInserted: successfully completed claim calls and
  newly inserted claim rows, differentiating idempotent replays.

Log one line per accepted signed customer callback, or any failed callback.
Successful status-only callbacks are not separately logged. Sampling is
bounded to 32 entries, 64 changes per entry, and eight provider references.

## Interpretation

- signature=verified, httpStatus=503, reason=receiver_config:
  Meta reached Render, and a local receiver activation gate rejected it.
- signature=verified, httpStatus=503, reason=sender_identity:
  A signed event reached Render but failed sender validation.
- signature=verified, httpStatus=200, phase=durable_claim:
  The handler successfully attempted durable storage. Check the matching
  processing job if the AI did not reply.
- signature=verified, httpStatus=200, large maxAgeSeconds:
  The event arrived late relative to Meta's original source timestamp.
  This does not by itself prove why it was late.
- No signed matching log:
  INCONCLUSIVE. Could be Meta nondelivery, pre-Node routing or downtime,
  logging gaps, or missing provider evidence. Request Meta delivery records.

## Correlation and privacy

To correlate a known Meta provider WAMID, an authorized operator can hash
the original value locally with SHA256 and use the first 20 lowercase hex
characters as a lookup reference for providerRefs. Do not paste a customer
identifier, token, raw webhook, or WAMID into public hashing websites.

No message contents, URLs, phone numbers, usernames, BSUIDs, customer IDs,
source ad IDs, raw WAMIDs, signatures or tokens appear in diagnostic logs.
Hashes are not a substitute for a signed provider receipt.

## Limitations

- A callback absent from application logs is not proof that Meta never sent it.
- The collector starts inside Node; upstream HTTP failures or service downtime
  may have no local record.
- No customer data is examined unless the raw webhook signature has passed
  verification.
- Failed and retried webhook events may appear more than once, linked by the
  same providerRefs value.
- More precise Meta delivery timelines require Meta-side delivery evidence.
