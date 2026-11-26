# PR 684 refresh: bounded CU improvements

This refresh preserves the hidden-Inbox event batching and stable maintenance scheduling changes against main at f962d14b21bc30604c7c73484f907d756712edcf, including PR 714 and PR 744. It retains SSE subscriptions, permission-sensitive refreshes, actual message deadlines and recovery.

The historical sender-specific candidate/due SQL and scheduler changes are intentionally deferred. PR 714 now has quiet-hours and due-hint preflight, bounded recovery, telemetry and combined marketing due queries. The former PR 684 scheduler assumes a different interface. Do not replace these newer paths or reintroduce three separate lane reads. A later separately reviewed change should scope each enabled lane before combining SQL and preserve global deadlines, failure recovery, billing wakes and one-shot send semantics. The previous implementation remains available in historical commit c1ff247c24e7fc86e1a1a6bdb320da5a3679f6de.

The last automated Neon usage report on November 25 showed 56.68 of 100 CU-hours used, with a baseline projection near 101.7. This was not a recent 24-hour measurement. Measure the current trend and individual worker sources before further optimization. No claimed savings until measured after deployment.

No production mutation or paid model call. Full CI on the new head and subsequent production review are required.
