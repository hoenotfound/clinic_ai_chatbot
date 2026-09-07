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

The executable requirements now come from the active industry's conversion contract:

### Aesthetic clinic

Clinic behavior stays compatible with the existing production flow:

- the patient clearly wants to proceed with the consultation;
- a configured clinic branch is chosen;
- a usable day/date plus time/range/daypart is captured;
- staff is alerted to verify the requested branch/time and confirm availability.

The existing `branch_name`, `treatment_interest`, `appointmentPreference`, `booking_ready` activity metadata, Inbox attention behavior, and Hot-lead side effect remain in place.

### Home renovation

Renovation can now reach its own business goal without pretending the customer's property is a clinic branch.

A renovation enquiry is conversion-ready only when:

- the customer clearly wants to proceed with a quotation discussion or site visit;
- a usable customer project/property location is captured;
- a concise project summary contains the current scope and useful context already provided by the customer;
- the next step is classified as `quotation_discussion` or `site_visit`;
- no human-handoff/safety condition takes priority.

Project-specific details are stored in the existing `lead_activities.metadata` JSON as:

- `projectLocation`
- `projectSummary`
- `nextStep`

No new lead columns are introduced in this migration. The legacy `treatment_interest` column may still store the canonical configured renovation service when one is known. The legacy `branch_name` column is not used for a customer's project/property location.

Renovation conversion-ready Telegram alerts show the project location, summary, requested next step, and the correct quotation/site-visit staff action instead of clinic appointment instructions.

Legacy `[[BOOKING_READY]]` marker-only output remains supported for the clinic appointment flow. Renovation requires structured JSON output because marker-only output cannot carry the project metadata needed to safely execute the conversion outcome.

### Generic

The generic profile still keeps executable conversion-ready automation disabled until a concrete generic next-step contract is defined.

## Recommended next migrations

1. Generalize the rule-based lead-temperature patterns that still contain clinic appointment vocabulary.
2. Allow industry profiles to supply default pipeline stages and qualification fields.
3. Add a dedicated onboarding/profile-selection action so industry choice happens atomically instead of through ordinary config PATCH requests.
4. Connect the profile choice to the internal client provisioner so creating a new Render + Neon instance seeds the correct industry automatically.
5. Gradually migrate legacy compatibility fields behind neutral domain names before any eventual database-column migration.

## Deployment model

```text
One GitHub production repo
        |
        +-- Client A Render -> Neon A -> aesthetic_clinic
        +-- Client B Render -> Neon B -> home_renovation
        +-- Client C Render -> Neon C -> generic / future profile
```

Bug fixes and core features stay in one codebase. Industry behavior and client facts stay in profile/config data rather than separate repositories.
