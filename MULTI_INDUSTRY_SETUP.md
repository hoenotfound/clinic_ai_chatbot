# Multi-industry foundation

The production chatbot remains one shared codebase. Each client can still have its own Render service and Neon database, while the database stores that client's business profile and configuration.

## Supported profiles

The shared repo currently includes:

- `aesthetic_clinic`
- `home_renovation`
- `generic`

**Aesthetic Clinic is the default profile.** A fresh deployment with no industry environment variable starts as `aesthetic_clinic` for backward compatibility.

The aesthetic-clinic profile preserves the historical clinic behavior and defaults. Renovation and generic profiles start with empty services, locations, FAQs and promotions so a fresh non-clinic client cannot inherit clinic facts.

## Choosing the industry for a fresh deployment

There are two supported paths.

### 1. Default clinic + Setup Status selector

With no industry environment variable, the fresh database starts with:

```text
businessType=aesthetic_clinic
```

The untouched default seed is temporarily selectable from **Setup Status > Business profile** by an administrator. Available choices are:

- Aesthetic Clinic — default
- Home Renovation
- General Business

The selection is a one-time onboarding action. It replaces the untouched profile config and default Pipeline together in one database transaction, then updates the live runtime only after that transaction commits.

The selector becomes unavailable when any of the following is true:

- the profile has already been confirmed;
- ordinary client Settings have been saved;
- contacts, messages or leads exist;
- the Pipeline has been customized;
- the deployment predates this selector and has no safe onboarding metadata.

The server rechecks these conditions inside the selection transaction, so a stale browser page cannot re-profile a client after customer activity begins.

### 2. Explicit provisioning environment variable

Provisioning can select the initial profile before the first startup:

```text
INITIAL_BUSINESS_TYPE=home_renovation
```

Accepted aliases include `renovation`, `carpentry`, and `cabinetry`.

An explicit provisioning choice is treated as authoritative and locked immediately. It is not later exposed as a switchable Setup Status profile. An invalid explicit value fails closed at startup rather than seeding the wrong industry.

Changing `INITIAL_BUSINESS_TYPE` after the database has already been seeded does not silently convert an existing client. The stored `businessType` remains authoritative.

### Internal Render + Neon client provisioner

The preferred repeatable path for a new client is now the internal provisioning CLI documented in `CLIENT_PROVISIONING.md`:

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --render-plan starter
```

The command is a dry run unless `--execute` is supplied. It requires the industry explicitly, checks Render and Neon for exact resource-name collisions, creates the Neon project, retrieves a pooled database connection, creates the Render service, and injects the canonical `INITIAL_BUSINESS_TYPE` before first startup.

This removes the normal provisioning gap where a Render + Neon pair could be created first and the operator could forget to select the intended industry later. Control-plane API keys stay in the operator environment and are never copied into the client service.

## Atomic profile alignment

The onboarding action changes the industry as one unit rather than PATCHing `businessType` by itself.

A successful selection aligns:

- `businessType` and industry terminology;
- the conversion-ready contract;
- default Pipeline stages;
- deterministic lead-temperature rules;
- Analytics Pipeline semantics;
- fresh profile services/locations/FAQs/promotions and other profile-owned defaults.

Normal Settings PATCH requests still cannot mutate `businessType`.

Setup Status also reports the active alignment for:

- Pipeline profile;
- conversion mode;
- lead-temperature rule profile;
- effective Analytics profile, including a legacy fallback when required by an established Pipeline.

## Compatibility during the migration

Several historical internal names remain in place temporarily:

- `clinicName`
- `branches`
- `treatment`
- `treatment_interest`
- `appointmentPreference`
- the `booking_ready` outcome

New code adds `businessName`, business terminology and industry-aware domain profiles while keeping these historical fields intact. This lets existing modules and database columns continue to work while the product is generalized in smaller, safer migrations.

Do not delete or rename the compatibility fields yet.

## Industry-aware conversion-ready flow

`booking_ready` remains the wire-level compatibility outcome for now, but it no longer means every industry behaves like a clinic appointment.

The executable requirements come from the active industry's conversion contract.

A neutral optional `conversion.conversionReadyEnabled` override is supported by the domain layer:

- omitted: use the industry's normal default and preserve the clinic's historical `bookingReadyEnabled` compatibility behavior;
- `true`: enable the industry's defined conversion-ready contract;
- `false`: disable executable conversion-ready outcomes for that deployment.

### Aesthetic clinic

Clinic behavior stays compatible with the existing production flow:

- the patient clearly wants to proceed with the consultation;
- a configured clinic branch is chosen;
- a usable day/date plus time/range/daypart is captured;
- staff is alerted to verify the requested branch/time and confirm availability.

The existing `branch_name`, `treatment_interest`, `appointmentPreference`, `booking_ready` activity metadata, Inbox attention behavior and Hot-lead side effect remain in place.

### Home renovation

Renovation can reach its own business goal without pretending the customer's property is a clinic branch.

Every renovation conversion-ready outcome must first have:

- clear customer intent to proceed;
- a canonical configured renovation service in the legacy `treatment` compatibility field;
- a usable customer project/property location;
- a concise project summary containing current scope/context already provided by the customer;
- a next step classified as `quotation_discussion` or `site_visit`;
- no human-handoff/safety condition taking priority.

Unknown, unsupported or hallucinated services cannot execute a renovation conversion-ready outcome. They must resolve to a configured renovation service first.

#### `quotation_discussion`

Required:

- configured service (`treatment` compatibility field);
- `projectLocation`;
- `projectSummary`.

`appointmentPreference` is optional unless useful timing was already provided.

#### `site_visit`

Required:

- configured service (`treatment` compatibility field);
- `projectLocation`;
- `projectSummary`;
- `appointmentPreference` containing the customer's preferred visit timing.

If a customer asks for a site visit without usable timing, the bot asks for it and keeps the outcome `normal`. Staff is alerted only after the site-visit request is sufficiently qualified.

Project-specific details remain in `lead_activities.metadata` as:

- `projectLocation`
- `projectSummary`
- `nextStep`

The legacy `branch_name` column remains the business/sales assignment and is not used for a customer's project location.

### Generic

The generic profile keeps executable conversion-ready automation disabled until a concrete generic next-step contract is defined.

## Industry-aware Pipeline and qualification

Profiles now supply default Pipeline stages and Lead Drawer qualification semantics.

### Aesthetic clinic defaults

The historical clinic stages remain unchanged.

### Home renovation defaults

1. New Lead (`new`)
2. Contacted (`contacted`)
3. Qualified (`qualified`)
4. Quotation / Site Visit (`next_step`)
5. Decision (`decision`)
6. Won (`won`)
7. Lost (`lost`)

Renovation project location, summary and requested next step are surfaced from the conversion activity metadata without repurposing `branch_name`.

Pipeline reseeding remains conservative: customized or in-use Pipelines are not silently replaced.

## Industry-aware rule-based lead temperature

Deterministic Hot/Cold conversation rules come from `leadTemperatureRuleProfiles` instead of assuming every lead is a clinic patient.

### Aesthetic clinic rules

The existing appointment/booking rules are preserved, including English, Bahasa Malaysia and Chinese booking intent, scheduling-context confirmations, uncertainty protection and explicit rejection handling.

### Home renovation rules

A renovation lead can become Hot from clear sales-progress intent such as:

- requesting a quotation;
- requesting or arranging a site visit/measurement;
- clearly saying they want to proceed, go ahead or start the project;
- asking how to pay a deposit or proceed;
- confirming a quotation/site-visit next step immediately after the chatbot asks how they want to continue.

Normal qualification/research remains Warm. Price/per-foot questions, service-area questions, material/design/timeline questions, property details, photos/floor plans, budget amounts, quote comparisons, price objections, tentative intent or a rejected site-visit time do not become Hot by themselves.

Existing transition safeguards remain unchanged:

- staff-locked temperatures are never changed by rules;
- Warm can move to Hot or Cold;
- Cold can recover to Hot;
- Hot can only move to Cold for an `absolute` rejection;
- rule writes continue to use `temperature_source = 'rule'` and the existing lead-activity path.

### Generic rules

The generic profile does not inherit clinic booking vocabulary or renovation quotation/site-visit vocabulary. Universal opt-out/wrong-number handling and clear generic rejection remain available, but no industry-specific Hot rule is enabled until a future profile defines one.

## Recommended next migrations

1. Run end-to-end renovation production hardening across realistic quotation, site-visit, budget, objection, multilingual, Human Takeover, Pipeline and Analytics scenarios.
2. Gradually migrate legacy compatibility fields behind neutral domain names before any eventual database-column migration.
3. If provisioning volume grows, put the same tested provisioning domain layer behind an internal admin surface while keeping Render/Neon control-plane credentials server-side and out of client runtimes.

## Deployment model

```text
One GitHub production repo
        |
        +-- Client A Render -> Neon A -> aesthetic_clinic
        +-- Client B Render -> Neon B -> home_renovation
        +-- Client C Render -> Neon C -> generic / future profile
```

Bug fixes and core features stay in one codebase. Industry behavior and client facts stay in profile/config data rather than separate repositories.
