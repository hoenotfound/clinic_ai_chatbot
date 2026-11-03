# Neutro secondary WhatsApp: all-contact AI replies

## Clinic decision
Neutro now allows conversational AI to answer **new incoming messages**
on the secondary WhatsApp number, including older customers, previously
synced contacts, existing primary-number customers, and direct/non-ad chats.

The change is **only** to the immediate AI reply audience. Keep existing
ads-only marketing and follow-up audiences and their opt-in requirements
unchanged. The primary WhatsApp is unaffected.

## Safe rollout
- Leave `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=ads_only` and the
  `WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT` value unchanged.
- Release the code with new setting OFF.
- After the new release is live, set both variables together:
  `WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE=all_contacts` and
  `WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT=<current UTC timestamp>`.
  Do not use an old timestamp. A missing, malformed or future timestamp
  blocks the broader audience.
- No database updates to `contacts.mode`, `needs_attention`, opt-outs,
  imported history records, or inbound processing jobs are needed.
- A message received **before** the switch time is never turned into a new
  AI reply, even if its durable job is retried after the switch.
- A new incoming message must be from the exact verified bound secondary
  sender, with a provider message ID, trusted source timestamp, and active
  sender account; the contact must still be in AI mode, with no outstanding
  staff attention and no WhatsApp opt-out.
- Recheck ownership and sender billing/policy at final outbound dispatch.
  If staff takes over or WhatsApp restricts the service window, block.
- Staff sending through the chatbot Inbox remains OFF. The WhatsApp
  Business App is still the way to reply manually on the secondary number.
- AI summaries, automated follow-ups, marketing templates, promo/result
  image queue and unrelated Telegram alert audiences are **not** expanded
  by this request. These still use their previous ad-only rules where set.

## Validation
1. Confirm the new GitHub backend and PostgreSQL tests pass.
2. Verify existing imported contacts have bound secondary sender rows
   without changing their historical messages.
3. Verify no pre-switch message becomes sendable under the new rule.
4. Verify a new direct message and a previously known customer are eligible,
   while a staff-owned, opted-out or misbound contact remains excluded.
5. Verify Inbox eligibility is batched and the staff-waiting Telegram alert
   does not promise to replay old messages.
6. Confirm deployment, health, schema version and absence of new
   automated outbound attempts for the existing historical test contact.

## Rollback
Set `WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE=ads_only`, leaving the original
ads-only automation audience and all other flags untouched. This restores
previous eligibility without editing customer data or retransmitting messages.
