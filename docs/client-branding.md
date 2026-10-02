# Per-client portal branding

Each client deployment can carry its own portal identity without changing shared frontend source code.

## Runtime environment

Put these values in that client's `--runtime-env-file` before provisioning:

```dotenv
CLIENT_DISPLAY_NAME="Acme Renovation"
CLIENT_LOGO_URL="https://cdn.example.com/acme-logo.png"
CLIENT_APP_ICON_180_URL="https://cdn.example.com/acme-app-180.png"
CLIENT_APP_ICON_192_URL="https://cdn.example.com/acme-app-192.png"
CLIENT_APP_ICON_512_URL="https://cdn.example.com/acme-app-512.png"
CLIENT_LOGIN_TAGLINE="Sign in to manage customer conversations"
```

`CLIENT_DISPLAY_NAME` is recommended. The logo, app-icon and login-tagline values are optional.

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


## Home-screen / installed web app branding

The normal `CLIENT_LOGO_URL` remains the flexible logo used inside the portal.
Installed-app icons use dedicated PNG assets so browsers never have to guess the
file dimensions:

- `CLIENT_APP_ICON_180_URL`: exact 180x180 PNG for iPhone/iPad `apple-touch-icon`;
- `CLIENT_APP_ICON_192_URL`: exact 192x192 PNG for Chromium/PWA installability;
- `CLIENT_APP_ICON_512_URL`: exact 512x512 PNG for Chromium/PWA installability.

Use square PNGs with safe padding around important artwork because mobile OS icon
masks can crop the outer edges. The URLs accept the same HTTPS or root-relative
forms as `CLIENT_LOGO_URL`; unsafe URLs are ignored.

If any install icon is missing or rejected, the portal uses packaged DA CHATBOT
fallback PNGs at the correct dimensions. This keeps Android and iOS Home Screen
icons valid even before a client-specific icon set is uploaded.

Installed launches start at `/login` because `/` is reserved for the Render
readiness endpoint. An already-authenticated staff session is then redirected
into the normal portal by the frontend router.
