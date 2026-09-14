# Multi-Client Ops Registry

The Ops Registry is a separate read-only control-plane deployment for viewing readiness across isolated DA Chatbot client instances.

## Isolation model

Each customer keeps its isolated runtime: one client Render service, one client Neon database, and its own client-side media storage boundary. Customer conversations, contacts, and application data remain in that client deployment.

The registry stores only operational metadata and sanitized readiness snapshots. It does not store customer conversations or client runtime credentials.

## Client readiness endpoint

Each enrolled client exposes the protected read-only Ops readiness endpoint. The registry polls that endpoint using the per-client pairing established during provisioning or recovery. The endpoint reports sanitized Go-Live state and does not trigger a new Go-Live run or mutate the client.

Only purchased channels are represented in the readiness contract. Facebook and Instagram remain separate channel records even though they share Meta webhook infrastructure.

## Automated enrollment during provisioning

When Ops enrollment is enabled, `provision-client` securely pairs the client with the central registry during normal provisioning. The pairing value is generated in memory and written through the Render control plane; it is not written to the provisioning receipt or registry database.

Enrollment modes remain:

- `auto`: enroll when the complete Ops control plane is configured; with neither required setting present, keep standalone behavior; partial configuration fails closed.
- `required`: require complete Ops configuration before client cloud creation. Recommended for production operators who do not want untracked deployments.
- `off`: deliberately skip fleet enrollment.

## Receipt compatibility

New provisioning writes receipt version 4 because automated R2 adds secret-free R2 recovery metadata.

The Ops tools intentionally accept both:

```text
receipt v3 = existing/legacy provisioning receipts
receipt v4 = current provisioning receipts with R2 recovery metadata
```

This keeps existing clients repairable while allowing newly provisioned clients to use the same Ops enrollment and registration workflows.

## Recovery and pairing rotation

If Ops enrollment is interrupted after client infrastructure exists, repair it from the receipt:

```bash
npm run ops:enroll-client -- \
  --receipt .provisioning/acme-clinic.json
```

The command accepts receipt v3 or v4. It creates a fresh pairing value, updates the client and registry through the provider control plane, redeploys as needed, verifies the exact client identity/profile/channel contract, and reconciles the existing registry row instead of creating duplicate infrastructure.

Re-running the command therefore acts as pairing rotation/reconciliation. The pairing value itself is never stored in the receipt.

## Manual registration compatibility

The older registration command remains available for deliberate manual operations and legacy deployments:

```bash
npm run ops:register-client -- \
  --receipt .provisioning/beleco-clinic.json \
  --name "Beleco Clinic"
```

It also accepts receipt v3 and v4. Registration imports only safe deployment metadata such as client slug, industry, purchased channels, Render identity, Neon identity, and deployed commit metadata.

## Registry behavior

The registry keeps its own database/migration namespace and remains separate from every client chatbot database. Its dashboard and API expose fleet status without giving the registry write access to client conversations or business data.

Current readiness states include the Go-Live states plus `offline` for polling/connectivity failures. A failed current poll keeps the previous successful readiness snapshot for diagnosis while marking the client offline.

Render commit metadata is used for version visibility when available. Version drift is informational and does not itself block Go-Live.
