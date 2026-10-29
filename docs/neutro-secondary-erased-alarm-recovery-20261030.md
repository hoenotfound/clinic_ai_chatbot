# Secondary billing alarm evidence review (draft)

This draft prepares an audited manual process for a secondary WhatsApp
billing alarm that remained after an authorized customer-data deletion.

No production changes have been made. The original message, its delivery
outcome, and any charge remain unverified. Existing privacy deletion is
preserved; historical data must not be recreated.

Before any operational action, an authorized reviewer must inspect the
original message in WhatsApp Business App and separately check Meta
billing evidence. A second reviewer must independently approve the
conclusion. If either source is inconclusive, the alarm must remain.

The proposed code is disabled by default, not connected to an endpoint
or worker, and requires explicit authorization. It records only hashes
of external evidence and a minimal explanation. It never sends messages,
enables follow-ups, or changes primary WhatsApp functionality.

Build pipeline capacity is exhausted. Do not deploy this draft. After
capacity resumes, first validate signed callbacks and primary Messenger
and WhatsApp health with all secondary outbound features disabled.
