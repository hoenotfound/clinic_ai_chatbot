# Diagnosing slow Inbox images

Photo selection, upload, provider acceptance and preview loading are separate operations. `.jpeg` and `.jpg` both represent JPEG; encoding and byte size determine the preparation path.

The browser creates an `X-Inbox-Request-Id`. Image and forward routes echo it. Match the ID across these logs without copying tokens, signed URLs, captions or image contents:

| Log | What it measures |
| --- | --- |
| `[Inbox image preparation]` | Input/output bytes and encoding; inspection, decode, encode and total browser preparation time |
| `[Inbox outbound queue]` | Earlier-send queue wait and actual request duration |
| `[Inbox image request]` | Browser-to-response-headers time and complete response time |
| `[Inbox media stage]` | Stage start and finish, including `providerPolicyMs` for the fresh policy lookup immediately before delivery |
| `[Inbox image timing]` | Multipart receipt, database preparation, R2 persistence, provider work, attachment linking, outcome persistence and pipeline update |
| `[WhatsApp media timing]` | Separate `upload`, `message_id` and `message_link` operations with header/body durations, status and timeout |
| `[Inbox forward timing]` | Source lookup, target queue wait, JPEG preparation, permanent/temporary R2 copies, fallback transfers, provider send and bookkeeping |
| `[Inbox image display]` | API-response-to-stored-image-load time, or image-load failure |

`routeMs` starts after multipart receipt. R2 and provider work overlap, so do not add their durations. Message API acceptance is not proof of device delivery; sent/delivered/read still comes from webhooks.

Default limits:

- Optional browser compression: 1.2 seconds, then use the valid original.
- Required browser inspection/conversion: 12 seconds total. Failure clears the attachment with a visible error and preserves the caption.
- Historical progressive JPEG conversion: one decoder per instance, four queued conversions with a 3-second queue deadline, and an 8-second decoder deadline. At most five historical image preparations may be outstanding. A killed decoder retains its slot until it exits.
- Stored JPEGs that need decoding must have valid 8-bit grayscale/RGB metadata, at most 16 million pixels and no side above 8192 pixels. Oversized/unsupported images fail before decoding with a request to upload a smaller JPEG or PNG. FFmpeg also enforces its own pixel limit and uses one decode/filter thread.
- A bounded process cache holds at most four entries for five minutes. New baseline object keys skip historical encoding inspection.
- R2 requests: `R2_REQUEST_TIMEOUT_MS`, default 10 seconds. Buffered downloads include body consumption in their deadline and have a byte limit.
- WhatsApp upload: `WHATSAPP_MEDIA_UPLOAD_TIMEOUT_MS`, default 15 seconds. Message submission: `WHATSAPP_MESSAGE_TIMEOUT_MS`, default 10 seconds. Both include response-body consumption.
- Inbox media bookkeeping and the fresh provider policy check: server-side statement timeout 10 seconds and lock timeout 5 seconds. Policy-check connections are released before provider delivery. Previous settings are restored before connection reuse. Background jobs and migrations retain their existing settings.

Send the troublesome JPEG and its baseline copy to the same open test conversation, then forward each saved message to the same target. Compare their request IDs and stage durations. Historical baseline JPEGs need one bounded header inspection; subsequent forwards use the cache. Progressive JPEGs are converted before provider submission. Each recipient still gets a separate durable object.

Storage/bookkeeping failure does not turn provider acceptance into an HTTP failure. R2 preparation failures before a provider call are definite failures. Ambiguous submissions remain unknown and require checking the customer chat before retrying. New drafts remain usable while outbound requests stay ordered. Local previews remain visible while the stored image loads.
