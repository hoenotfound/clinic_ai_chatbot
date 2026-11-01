# Neutro secondary WhatsApp: ads-only AI activation

The second sender is independent from the primary Neutro WhatsApp and Facebook Messenger.

## Activation requirements

- Set the secondary audience to `ads_only` and an activation UTC timestamp on rollout. Never backdate it. Existing chats, imported history, direct traffic and contacts first seen before activation remain excluded.
- Require a settled sender billing ledger, signed receipt ingestion, verified Meta phone/account identity, approved shared Neutro clinic content and separate secondary billing gates.
- Keep `WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED=false`, `WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=false`, `WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED=false`, `WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED=false`, and the secondary history receiver off. Business App staff messaging is unaffected.
- Enable automated AI media and 2h/6h/20h follow-up sending only after independent approval and sender-scoped rule configuration. Feature flags do not create the rules.
- Marketing templates at 48h/72h need independently verified Meta-approved secondary templates, message-linked treatment-specific marketing consent, signed template rules, explicit billing approval, and one-shot attempts. Neither an ad click nor a 24h service window is marketing consent.
- Monitor delivery receipts, pricing, billing alarms, callback signatures, one-shot follow-ups, and provider billing before increasing activation.
- Do not retry any message with an UNKNOWN provider outcome. Retain receipts and customer opt-out safeguards.

This PR adds a separate full AI authorization mode. It does not alter any production activation flag by itself.