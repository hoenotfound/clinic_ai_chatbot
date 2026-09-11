# Per-client portal branding

Each client deployment can carry its own portal identity without changing shared frontend source code.

## Runtime environment

Put these values in that client's `--runtime-env-file` before provisioning:

```dotenv
CLIENT_DISPLAY_NAME="Acme Renovation"
CLIENT_LOGO_URL="https://cdn.example.com/acme-logo.png"
CLIENT_LOGIN_TAGLINE="Sign in to manage customer conversations"
```

`CLIENT_DISPLAY_NAME` is recommended. `CLIENT_LOGO_URL` and `CLIENT_LOGIN_TAGLINE` are optional.

The existing provisioner copies non-reserved runtime values only into that client's Render service. These branding values are not Ops control-plane secrets and are safe to expose on the public login screen.

## Name precedence

The portal chooses the displayed client name in this order:

1. the real business name saved in Client Setup / Settings;
2. `CLIENT_DISPLAY_NAME` from that client deployment;
3. a human-readable version of `CLIENT_SLUG`;
4. `Client Portal` as the final neutral fallback.

On a fresh database, `CLIENT_DISPLAY_NAME` also seeds `businessName` and the legacy-compatible `clinicName` field. Later edits in Client Setup remain the source of truth for the business name.

## Logo behavior

`CLIENT_LOGO_URL` accepts HTTPS URLs and safe root-relative paths. HTTP, `data:`, `javascript:`, protocol-relative and malformed URLs are ignored.

If no valid logo is configured, the login page and sidebar show a generated initials tile. They never fall back to another client's logo.

## Login tagline

If `CLIENT_LOGIN_TAGLINE` is missing, the portal uses:

```text
Sign in to manage customer conversations
```

The browser tab title also follows the resolved client name.

## Agency identity

The small `Powered by DA Smarketing Solutions` credit remains shared agency branding. Client branding and agency branding are intentionally separate.
