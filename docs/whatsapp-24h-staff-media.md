# Optional 24-hour WhatsApp staff media

**Off by default.** In Tools > Automated Follow-up > WhatsApp, leave Strict
RM0 enabled and separately opt in to staff-sent media. Meta may charge
service-message fees even inside the 24-hour customer-service window.

Eligible: ordinary **staff-initiated** Inbox images, videos, documents, voice,
stickers, and forwarded media saved under the authenticated staff username,
with matching recipient, durable media MIME metadata, and a genuine customer
WhatsApp provider message received within the last 23h58m. The Inbox and
provider still check the standard customer-service policy window.

Excluded: automatic before-and-after/result images, marketing reminders,
videos from follow-ups, consent prompts, scheduled sends, templates, and
conversations without a recent provider-authored customer message. These
retain the original Strict RM0 CTWA/FEP authorization.

Migration 072 adds `send_kind` to the existing durable one-shot exception
records; pre-existing rows default to `text`. Staff media is recorded as
`staff_media` and retains the same provider WAMID, billing categorization,
duplicate suppression and ambiguous-send protection. Only definitely
rejected provider attempts may release the one-shot reservation.

After merging and successful Render deployment, opt in on the production
Tools page, test a staff image to an active organic test conversation,
and monitor service charges and unexpected billing alerts. If needed,
disable just the staff media toggle as an immediate rollback.
