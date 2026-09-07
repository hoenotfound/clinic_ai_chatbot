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

New code adds `businessName`, business terminology, and conversion metadata while keeping `businessName` and `clinicName` synchronized. This lets existing modules and database columns continue to work while the product is generalized in smaller, safer migrations.

Do not delete or rename the compatibility fields yet.

## Why booking_ready is disabled for non-clinic profiles for now

The current executable `booking_ready` path assumes that the customer has selected a configured business branch and supplied an appointment time. That is correct for the current clinic flow, but it is not generally correct for industries such as renovation, where the next step may be a site visit at the customer's property or a quotation discussion.

Therefore:

- `aesthetic_clinic`: `booking_ready` remains enabled.
- `home_renovation`: `booking_ready` is disabled; the AI can still qualify and guide the customer, but staff confirms the site visit/quotation step.
- `generic`: `booking_ready` is disabled.

This avoids forcing clinic assumptions into other industries before the conversion outcome schema is generalized.

## Recommended next migrations

1. Make Settings labels industry-aware and expose `businessName` instead of clinic-only wording.
2. Add a dedicated onboarding/profile-selection action so industry changes happen atomically rather than through ordinary config PATCH requests.
3. Generalize the booking-ready outcome and CRM metadata into an industry-neutral conversion-ready/next-step model while preserving old data.
4. Generalize the rule-based lead-temperature patterns that still contain clinic appointment vocabulary.
5. Allow industry profiles to supply default pipeline stages and qualification fields.
6. Connect the profile choice to the internal client provisioner so creating a new Render + Neon instance seeds the correct industry automatically.

## Deployment model

```text
One GitHub production repo
        |
        +-- Client A Render -> Neon A -> aesthetic_clinic
        +-- Client B Render -> Neon B -> home_renovation
        +-- Client C Render -> Neon C -> generic / future profile
```

Bug fixes and core features stay in one codebase. Industry behavior and client facts stay in profile/config data rather than separate repositories.
