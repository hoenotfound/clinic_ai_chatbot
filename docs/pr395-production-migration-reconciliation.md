# WhatsApp PR #395 migration reconciliation: production-safe plan

**READ-ONLY DESIGN / NOT APPLIED.** This is a manifest, NOT a deployable
migration. Current production Neon project remains at version 077. Current
`main` has different, immutable sales-follow-up migration versions 078 and
079. Isolated PR #395 QA Neon has already applied WhatsApp migrations 078
through 104, with an incompatible history. **Do not merge PR #395 wholesale.**

## Why a rename cannot be run on the existing QA database

Both databases use `schema_migrations` to validate version, filename-derived
name and SHA-256 SQL checksum. Renaming or rewriting already-applied QA 078–104
breaks QA's history; using them as production 078/079 replaces the sales schema
and breaks production's migration lineage. Never edit the original files in
PR #395, truncate `schema_migrations`, or copy QA history into production.

## Proposed forward-only target for a NEW production lineage

Once main migrations 078/079 are approved, audit each WhatsApp migration's
SQL, FK dependencies, names, transactional behavior, and test coverage.
On a fresh branch based on main, **copy** the PR #395 SQL into new files
numbered 080–106, then inspect every statement, checksum, references and
whether source code requires adaptation. The following is a candidate mapping,
not proof that the copied SQL is safe or directly applicable.

| Existing isolated-QA version | Proposed NEW version | Name | Original Git blob |
|---|---|---|---|
| 078 | 080 | `whatsapp_sender_foundation.sql` | `321215e2ce421818b01186e659f1e237d72126f7` |
| 079 | 081 | `whatsapp_sender_conversation_identity.sql` | `79a5cf5c299446a02e8f4af36c291016bc7d99b8` |
| 080 | 082 | `whatsapp_sender_scoped_contact_identity.sql` | `e86f09d9c86389e963f3b90ef00a5cf7fb7fe80a` |
| 081 | 083 | `whatsapp_sender_binding_integrity.sql` | `96f64360e1d7d8bddf47d81e4205b980bf6f6103` |
| 082 | 084 | `whatsapp_delivery_sender_provenance.sql` | `4d822cb06b15726b1488e73bd08c3843962f8bff` |
| 083 | 085 | `whatsapp_sender_billing_gate.sql` | `1398e4e2c9bd607d17527c4beda97725a04e8078` |
| 084 | 086 | `whatsapp_sender_status_receipts.sql` | `284430a231ce10e62126ea6dc768bd81fba6fd89` |
| 085 | 087 | `whatsapp_sender_billing_reconciliation.sql` | `7c9b127d868682b5f8b1165279ceafee6f1e5224` |
| 086 | 088 | `whatsapp_sender_message_idempotency.sql` | `6d99d4a7076c1ed2df4c7a4dc57a28c7f5be54be` |
| 087 | 089 | `whatsapp_sender_verified_autosettlement.sql` | `843eb8f9355b00fc7a9ae2834906c3a2a2f05f82` |
| 088 | 090 | `whatsapp_sender_explicit_charge_reconciliation.sql` | `b1613ed2d27e97bb8f9b61ca61f3a0d52d04b6ea` |
| 089 | 091 | `whatsapp_sender_followup_rules.sql` | `cba6ed4072de7640c5baa23ac11a1fd64dbdc7c3` |
| 090 | 092 | `whatsapp_sender_free_service_receipt.sql` | `9e931f6e654722749fa617cf4d1f1258c960e6d7` |
| 091 | 093 | `whatsapp_sender_rejection_and_unmatched_charge.sql` | `45a575db902dfe1707c6895a41d545fc681028b2` |
| 092 | 094 | `whatsapp_sender_privacy_safe_erasure.sql` | `1c38fec3010b90b06b802c9ac9c75faa023c404e` |
| 093 | 095 | `whatsapp_sender_early_receipt_recipient_proof.sql` | `21405040ce2f48676331a595c7e04c22d68ab7d7` |
| 094 | 096 | `whatsapp_sender_operator_service_charge.sql` | `3cf6b2b4c9002d55b0584b9392c7aeb917be8d44` |
| 095 | 097 | `whatsapp_sender_ai_media_queue.sql` | `fdd9e86f57ab61a0a2253839fac867b10459e1e8` |
| 096 | 098 | `whatsapp_sender_coexistence_media_jobs.sql` | `c186b7ba70bf9ca56fe42ab1dac04ea6d1a163fe` |
| 097 | 099 | `whatsapp_sender_coexistence_sync.sql` | `110989372f032871fa1bae695f99a0d51948fedf` |
| 098 | 100 | `whatsapp_sender_coexistence_mutations.sql` | `dd6ccdf36760f25b13a2ba42356c49f25bf467df` |
| 099 | 101 | `whatsapp_sender_coexistence_import_jobs.sql` | `756125ba8bd8f86a2af04e30ca95455a5bb98ce1` |
| 100 | 102 | `whatsapp_sender_coexistence_lifecycle.sql` | `1ed8be4f92afd0f1791316e58a8688a2416c1e82` |
| 101 | 103 | `whatsapp_coexistence_encrypted_credentials.sql` | `c5e0ba7f3612290410a21f9dc5fe5ec83a13b6d1` |
| 102 | 104 | `whatsapp_coexistence_preidentity_events.sql` | `e85b03d0608eca51ea0b48ee50a494e2ca0e6b47` |
| 103 | 105 | `whatsapp_legacy_lifecycle_relay_audit.sql` | `cb21c6683d209cde60b3bd31b623f3239c259e23` |
| 104 | 106 | `whatsapp_coexistence_once_only_and_lifecycle_alerts.sql` | `f3ab0ee689d01ccce0c4b6d631e4a9a19be99f86` |

Source PR #395 commit: `662af9d16e911dd30825f861987e0dbcb1888340`.
Current main baseline commit: `266be97a7e984ac940f37a4920fe80083da24db7`.
Both must be rechecked before creating future migrations.

## Deployment gates

1. Keep old QA v078–v104 immutable, accessible only to isolated QA code and
   separate QA Neon connections. Existing PR #395 stays draft, not merged.
2. Do not put `ops/qa-only/*` SQL into production's
   `src/db/migrations` directory. QA DDL requires explicit separate approval.
3. Reconcile code imports, SQL dependencies, version references and sender
   tables; test migration 077→079→106 on a brand-new disposable restored
   schema with no production changes.
4. Test rollback *without* attempting to deploy the old v079-only recovery
   build after v080+ is applied. A new compatible rollback build must include
   all forward migration files, since the runner rejects newer DB histories.
5. Rehearse two simultaneous numbers, duplicate/missing webhooks, repeated
   QR/history events, opt-ins, media/status receipts, schema indexes, Neon Free
   compute limits and one paid Render memory spikes.
6. Roll out only after a separately approved production release and Meta field
   and account/phone override verification.

**Current short-term release boundary remains schema 079**. PR #411's
rollback guard rejects future migrations beyond 079. PR #412 adds only an
optional encrypted QA capture route and an isolated QA-only DDL artifact;
it does NOT copy or apply any of the proposed production migrations.

## Additional reconciliation finding (28 Oct 2026)

Independent inspection of original PR #395 SQL found two migrations that
**change referential integrity**, not just append tables. Original
`080_whatsapp_sender_scoped_contact_identity.sql` (proposed NEW 082)
creates sender-scoped replacement contact indexes and then **drops**
`contacts_whatsapp_number_key`. Original
`081_whatsapp_sender_binding_integrity.sql` (proposed NEW 083)
**drops and recreates** three foreign-key constraints with CASCADE/RESTRICT
semantics. These may be correct for multi-sender isolation, but require an
actual restored-production dataset with index/constraint inventory and
rollback tests. They are NOT safe to blindly renumber and auto-apply to
Neutro, even if unit tests pass.

**Decision:** keep v080–106 a manifest only. Do not merge PR #395 SQL
until full schema reconciliation and realistic data/regression checks
are independently approved. An initial receive-only QR rehearsal on
isolated QA does NOT need these migrations and cannot claim a functional
shared Inbox, AI, or follow-up support for the second sender.
