# Diagnosing slow Inbox images

Photo selection, upload, provider acceptance and preview loading are separate operations. `.jpeg` and `.jpg` both represent JPEG; encoding and byte size determine the preparation path.

The browser creates an `X-Inbox-Request-Id`. Image and forward routes echo it. By default, each Inbox image/video/document request generates a single `[Inbox media summary]` entry with request ID, internal contact ID, channel, byte size, provider acceptance outcome, HTTP status, total time and per-stage elapsed times. Forwarded images get one summary per target. No tokens, media keys, signed URLs, captions or image contents are logged.

Set `INBOX_MEDIA_VERBOSE_LOGS=true` temporarily on a Render service to restore individual stage and successful WhatsApp API timing logs for investigation; unset it afterward. Failures, HTTP errors, timeouts and persistence warnings remain visible in the default mode. Log level `info` means the provider accepted a send, not that a customer's device received it.

Additional debugging log families:

| Log | What it measures |
| --- | --- |
| `[Inbox image preparation]` | Input/output bytes and encoding; inspection, decode, encode and total browser preparation time |
| `[Inbox outbound queue]` | Earlier-send queue wait and actual request duration |
| `[Inbox image request]` | Browser-to-response-headers time and complete response time |
| `[Inbox media summary]` | **Default:** one concise outcome and stage-duration record per request (or forwarded image target), warning on failure or incomplete persistence |
| `[Inbox media stage]` | **Verbose only:** stage start and finish, including `providerPolicyMs` for the fresh policy lookup immediately before delivery |
| `[Inbox image timing]` | **Verbose only:** extra timings on slow image requests |
| `[WhatsApp media timing]` | Separate `upload`, `message_id` and `message_link` timings: default only for non-2xx responses / timeouts; all operations in verbose mode |
| `[Inbox forward timing]` | **Verbose only:** extra image-forward diagnostics; the default forward summary includes key stage durations |
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
