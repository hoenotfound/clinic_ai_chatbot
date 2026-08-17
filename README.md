# WhatsApp AI Clinic Bot + Management Portal

AI receptionist for aesthetics clinics that replies to patients on WhatsApp, plus a management portal for staff to view conversations. Chat history is now saved permanently (SQLite) — no longer wiped on restart.

## How it works

```
Patient WhatsApp message
   → Meta WhatsApp Cloud API (webhook)
   → your server (src/server.js)
   → AI reply (Claude or Gemini — src/services/aiService.js), using clinic info from src/config/clinicConfig.js
   → reply sent back via WhatsApp Cloud API
   → everything saved to SQLite (src/db/) — visible in the portal, in real time
```

**Management portal** (`portal-frontend/`): a staff-only web dashboard.
- **Inbox** — live, working. Every conversation, chat-bubble thread view, auto-refreshes every 5s.
- **Contacts, Pipeline, Settings** — placeholder pages in the nav, marked "Soon". No functionality yet, but the URLs, layout, and database tables (`leads`, `pipeline_stages`) already exist so building these next doesn't require restructuring anything.

---

## 1. Fill in the clinic details

Open `src/config/clinicConfig.js` and replace every `[PLACEHOLDER]` — name, address, hours, services, prices, FAQs, SOP, and escalation rules. This file is the bot's entire "brain."

## 2. Get your credentials

**AI provider** — controlled by `AI_PROVIDER` in `.env`, either works, switching later is a one-line change:
- **Gemini**: [aistudio.google.com](https://aistudio.google.com) → Get API Key. Free tier, tighter rate limits — good for testing.
- **Claude**: [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key. No free tier, no rate-limit surprises — switch to this before real patient traffic.

**Meta WhatsApp Cloud API:**
1. [developers.facebook.com](https://developers.facebook.com) → My Apps → create an app → add the **WhatsApp** product.
2. Under WhatsApp → API Setup you'll find: a **temporary access token**, a **test phone number** + **Phone Number ID**, and a place to add **your own phone number** as a tester.
3. Under App Settings → Basic, note your **App Secret** (needed for webhook signature verification).

## 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in:
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` — from step 2
- `WHATSAPP_APP_SECRET` — from step 2; verifies webhooks are genuinely from Meta
- `WHATSAPP_VERIFY_TOKEN` — any string you make up, reused in step 6
- `AI_PROVIDER` + `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`
- `SESSION_SECRET` — a long random string for signing staff login cookies. Generate one:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `DATABASE_PATH` — leave as default unless you have a reason to change it

## 4. Install and create a staff login

```bash
npm install
npm run create-user -- drtan yourpassword
```

Run this once per staff member who needs portal access (everyone currently has identical access — no roles yet).

## 5. Build the portal and start the server

```bash
cd portal-frontend && npm install && npm run build && cd ..
npm start
```

Visit `http://localhost:3000/inbox` and log in with the account you just created.

**For active frontend development** (auto-reloading on changes), run these in two terminals instead:
```bash
npm start                              # terminal 1 — backend on :3000
cd portal-frontend && npm run dev      # terminal 2 — frontend on :5173, proxies /api to :3000
```
Use `:5173` while iterating on the UI; the `:3000` build is what you'd actually deploy.

## 6. Expose your server and connect the WhatsApp webhook

```bash
ngrok http 3000
```

In Meta Developer Console → WhatsApp → Configuration:
- **Callback URL**: `https://your-ngrok-url.ngrok-free.app/webhook`
- **Verify token**: your `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and Save**, then subscribe to the `messages` webhook field

## 7. Test it

WhatsApp the test number from your phone (added as a tester in step 2). Watch the conversation appear live in the portal's Inbox, and check the server console for logs.

---

## Known limitations (by design, for this phase)

- **No real booking.** The bot says a team member will confirm — it can't check/reserve slots yet.
- **Inbox is read-only.** Staff can view chat history but can't reply from the portal yet, take over a conversation, or get notified of new messages beyond the 5s poll.
- **Text messages only.** Images/voice notes get a polite fallback reply.
- **Single WhatsApp number, single clinic.** Multi-branch isn't built yet.
- **All staff have identical access.** No roles/permissions yet — the `users` table supports adding this later without a redesign.

## Suggested next phases

1. **Contacts** — patient directory backed by the `contacts` table (already storing name + number); add notes, tags, history-at-a-glance.
2. **Pipeline** — lead tracking using the `leads`/`pipeline_stages` tables already in the schema; drag-and-drop board from New Lead → Contacted → Booked → Converted.
3. **Real-time inbox** — swap polling for WebSockets/SSE, add staff "reply from portal" and manual takeover.
4. **Real appointment booking** — connect a calendar (Google Calendar/Cal.com).
5. **Staff roles** — e.g. admin vs front-desk, using the existing `users` table.
6. **Notifications on handoff** — when the bot escalates to a human (see `clinicConfig.js` → `escalation`), alert staff somewhere they'll actually see it.
