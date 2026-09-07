# Multi-industry foundation

The production chatbot should remain one shared codebase. Each client can still have its own Render service and Neon database, while the database stores that client's business profile and configuration.

## Supported initial profiles

This foundation currently includes:

- `aesthetic_clinic`
- `home_renovation`
- `generic`

The aesthetic clinic profile intentionally preserves the existing Beleco-based defaults so current deployments do not change behavior simply because this foundation is deployed.

The renovation and generic profiles start with empty services, locations, FAQs, and promotions. They therefore cannot accidentally quote a Beleco treatment or clinic fact before a new client has been configured.

## Creating a fresh non-clinic deployment

Set the initial industry before the new Render service starts against its fresh Neon database:

```text
INITIAL_BUSINESS_TYPE=home_renovation
```

Accepted aliases include `renovation`, `carpentry`, and `cabinetry`. New deployments with no industry variable continue to default to `aesthetic_clinic` for backward compatibility.

The value only selects the profile used when the `clinic_config` table has no config row yet. Once the database has been seeded, the stored `businessType` is authoritative. Changing the environment variable later does not silently convert an existing client's industry.

An invalid explicit industry value fails closed at startup rather than seeding the wrong profile.

## Compatibility during the migration

Several historical internal names remain in place temporarily:

- `clinicName`
- `branches`
- `treatment`
- `treatment_interest`
- `appointmentPreference`
- the `booking_ready` outcome

New code adds `businessName`, business terminology, and an industry-aware conversion contract while keeping the historical fields intact. This lets existing modules and database columns continue to work while the product is generalized in smaller, safer migrations.

Do not delete or rename the compatibility fields yet.

## Industry-aware conversion-ready flow

`booking_ready` remains the wire-level compatibility outcome for now, but it no longer means every industry must behave like a clinic appointment.

The executable requirements now come from the active industry's conversion contract.

A neutral optional `conversion.conversionReadyEnabled` override is also supported by the domain layer:

- omitted: use the industry's normal default and preserve the clinic's historical `bookingReadyEnabled` compatibility behavior;
- `true`: enable the industry's defined conversion-ready contract;
- `false`: disable executable conversion-ready outcomes for that deployment.

This neutral override is intentionally backend-only for now. A later onboarding/settings migration can expose it without reusing clinic-specific terminology.

### Aesthetic clinic

Clinic behavior stays compatible with the existing production flow:

- the patient clearly wants to proceed with the consultation;
- a configured clinic branch is chosen;
- a usable day/date plus time/range/daypart is captured;
- staff is alerted to verify the requested branch/time and confirm availability.

The existing `branch_name`, `treatment_interest`, `appointmentPreference`, `booking_ready` activity metadata, Inbox attention behavior, and Hot-lead side effect remain in place.

### Home renovation

Renovation can now reach its own business goal without pretending the customer's property is a clinic branch.

Every renovation conversion-ready outcome must first have:

- clear customer intent to proceed;
- a canonical configured renovation service in the legacy `treatment` compatibility field;
- a usable customer project/property location;
- a concise project summary containing the current scope and useful context already provided by the customer;
- a next step classified as `quotation_discussion` or `site_visit`;
- no human-handoff/safety condition taking priority.

An unknown, unsupported, or hallucinated service cannot execute a renovation conversion-ready outcome. It must resolve to one of the configured renovation services first. This also means a fresh renovation profile with no configured services cannot accidentally become conversion-ready.

The two renovation next steps deliberately have different requirements:

#### `quotation_discussion`

Required:

- configured service (`treatment` compatibility field);
- `projectLocation`;
- `projectSummary`.

`appointmentPreference` is optional unless the customer already provided useful timing information.

#### `site_visit`

Required:

- configured service (`treatment` compatibility field);
- `projectLocation`;
- `projectSummary`;
- `appointmentPreference` containing the customer's current preferred visit timing.

If a customer asks for a site visit but has not yet provided a usable day/date and time/range/daypart, the bot should ask for that timing and keep the outcome `normal`. Staff is alerted only after the site-visit request is sufficiently qualified for follow-up.

Project-specific details are stored in the existing `lead_activities.metadata` JSON as:

- `projectLocation`
- `projectSummary`
- `nextStep`

No new lead columns are introduced in this migration. The legacy `treatment_interest` column stores the canonical configured renovation service when the conversion-ready outcome executes. The legacy `branch_name` column is not used for a customer's project/property location.

Renovation conversion-ready Telegram alerts show the service, project location, summary, requested next step, optional/preferred timing, and the correct quotation/site-visit staff action instead of clinic appointment instructions.

Legacy `[[BOOKING_READY]]` marker-only output remains supported for the clinic appointment flow. Renovation requires structured JSON output because marker-only output cannot carry the project metadata needed to safely execute the conversion outcome.

### Generic

The generic profile still keeps executable conversion-ready automation disabled until a concrete generic next-step contract is defined.

## Industry-aware rule-based lead temperature

Deterministic Hot/Cold conversation rules now come from `leadTemperatureRuleProfiles` instead of assuming every lead is a clinic patient.

### Aesthetic clinic rules

The existing appointment/booking rules are preserved, including English, Bahasa Malaysia, and Chinese booking intent, scheduling-context confirmations, uncertainty protection, and explicit rejection handling.

### Home renovation rules

A renovation lead can become Hot from clear sales-progress intent such as:

- requesting a quotation;
- requesting or arranging a site visit/measurement;
- clearly saying they want to proceed, go ahead, or start the project;
- asking how to pay a deposit or proceed;
- confirming a quotation/site-visit next step immediately after the chatbot asks how they want to continue.

Normal qualification/research remains Warm. Price/per-foot questions, service-area questions, materials/design/timeline questions, property/project details, photos/floor plans, a budget amount, comparing quotations, an expensive quote, tentative intent, or a rejected site-visit time do not become Hot by themselves.

Explicit rejection can cool a Warm renovation lead. Definitive project-ending signals such as an explicitly cancelled project or having already hired another contractor/designer are marked `absolute`, along with universal wrong-number/stop-contact signals.

The existing transition safeguards remain unchanged:

- staff-locked temperatures are never changed by rules;
- Warm can move to Hot or Cold;
- Cold can recover to Hot;
- Hot can only move to Cold for an `absolute` rejection;
- rule writes continue to use `temperature_source = 'rule'` and the existing lead-activity path.

### Generic rules

The generic profile does not inherit clinic booking vocabulary or renovation quotation/site-visit vocabulary. Universal opt-out/wrong-number handling and clear generic rejection remain available, but no industry-specific Hot rule is enabled until a future profile defines one.

## Recommended next migrations

1. Allow industry profiles to supply default pipeline stages and qualification fields, and surface renovation project metadata clearly in the lead drawer.
2. Add a dedicated onboarding/profile-selection action so industry choice happens atomically instead of through ordinary config PATCH requests.
3. Connect the profile choice to the internal client provisioner so creating a new Render + Neon instance seeds the correct industry automatically.
4. Gradually migrate legacy compatibility fields behind neutral domain names before any eventual database-column migration.

## Deployment model

```text
One GitHub production repo
        |
        +-- Client A Render -> Neon A -> aesthetic_clinic
        +-- Client B Render -> Neon B -> home_renovation
        +-- Client C Render -> Neon C -> generic / future profile
```

Bug fixes and core features stay in one codebase. Industry behavior and client facts stay in profile/config data rather than separate repositories.
