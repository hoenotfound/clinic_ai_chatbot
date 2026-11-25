# Dashy Inbox mascot

Artwork: the owner's 12-page Dashy Expression PDF includes ten illustrated poses. The ten transparent WebP files under portal-frontend/src/assets/dashy are aligned to a common 160 × 160 canvas, with roughly the same head position and scale. The live art is at most 52px on desktop and 60px on phones; the smaller desktop size preserves clearance above the search control. Page 11 (Sleeping) and page 12 (Interactive) contain headings only. Pages 1, 2 and 4 are unlabeled; Welcome, Crossed hands and Confident are descriptive preview labels.

Automatic Inbox behavior:
- Greeting on entry (and a brief greeting for identified new-message activity in the currently open conversation).
- Idle with occasional gentle movement; roaming is a brief bounded movement within the safe header area, not over conversations.
- Searching while a nonempty search is loading through the existing list request.
- Alert only when a selected-conversation delivery failure is reported.
- Success when a staff send returns the existing verified bookingSynced result. Automated AI appointments are not inferred.
- Thinking, crossed hands and confident artwork can be previewed in Appearance but are not assigned to speculative operational states. No true AI generation-start event is available to this frontend.
- Identifiable event reactions are prioritized and deduplicated; redacted events do not trigger a mascot reaction.

Settings → Appearance provides Animated, Stationary, Hidden and an expression preview. The preference is browser-local, supports the previous visibility toggle, and respects reduced motion. Background tabs stop timers. The original initial mascot remains a defensive image fallback. Images load from the same Vite build (no third-party asset URLs). No additional backend queries, polling, SSE connections, AI calls or dependencies.

Manual visual review: desktop and mobile, narrow header and long counts, light and dark modes, reduced motion, all display modes, search, selected-conversation message/delivery events, and confirmed staff appointment. Confirm existing Inbox controls remain accessible.
