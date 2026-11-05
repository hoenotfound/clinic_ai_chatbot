# Neutro Sense historical case verification, 5 November 2026

This change updates the future secondary 48h/66h follow-up eligibility and the
read-only staff delivery review. It does not send or retry WhatsApp messages,
change pricing, or rewrite past appointment records.

## Staff actions

| Contact | Evidence | Required review |
| --- | --- | --- |
| #7245 | Staff acknowledged 7 Nov, 3:30 PM; lead still says appointment_status=none; unresolved booking_ready hold | Verify clinic calendar and save the appointment in CRM or explicitly release the hold |
| #1046 | Staff acknowledged 29 Nov, 3 PM; lead still says appointment_status=none; unresolved booking_ready hold | Verify calendar and save the appointment in CRM or release the hold |
| #8930 | One 4 Nov Before & After image was marked read; another queued image expired. A 2h follow-up has unknown delivery | Check original WhatsApp chat and Meta billing/delivery evidence. Do not retry uncertain send |
| #7772 | One 4 Nov image delivered; another queued image expired | Check the conversation and confirm whether the customer still needs a second image |
| #8937 | Two AI image jobs expired; staff subsequently sent two image messages marked read | Confirm those were the intended media before considering any new image |
| #8936 | Scoliosis enquiry in pending clinical review | Clinical staff must handle, no automated suitability assurance |
| #8938 | Meta error 131060 hid original inbound content | Check WhatsApp Business App; don't invent content |
| #8932 | Supplier/partnership outreach | Should not receive irrelevant promotional followups |

The secondary WhatsApp all-contact audience, opt-outs, sender-bound identities,
verified promotional-image selection, billing safeguards, and Day4/Day6 feature
flags remain unchanged. Only a staff member with access to the source booking
and Meta evidence should resolve these historical records.
