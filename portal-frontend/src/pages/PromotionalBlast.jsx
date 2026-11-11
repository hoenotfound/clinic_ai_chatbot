import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

const CAMPAIGN = "ns_3d_1111_rm388_2026";
const LANGUAGES = [
  { value: "zh_CN", label: "中文" },
  { value: "en_US", label: "English" },
  { value: "ms", label: "Bahasa Melayu" },
];

function fmtTime(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function sendable(person) {
  return !person.alreadyClaimed && !person.blockedReason &&
    new Date(person.expiresAt).getTime() > Date.now();
}

export default function PromotionalBlast() {
  const [recipients, setRecipients] = useState([]);
  const [selected, setSelected] = useState({});
  const [languages, setLanguages] = useState({});
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [billingApproved, setBillingApproved] = useState(false);
  const [consentReviewed, setConsentReviewed] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState([]);
  const stopRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getPromotionalBlastPreview();
      if (data.campaignKey !== CAMPAIGN) throw new Error("Campaign configuration changed.");
      setRecipients(data.recipients || []);
      setSelected({});
      setLanguages(previous => Object.fromEntries(
        (data.recipients || []).map(person => [
          person.contactId, previous[person.contactId] || person.suggestedLanguage || "zh_CN",
        ])
      ));
    } catch (err) {
      setError(err.message || "Could not verify recipients.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const allowed = useMemo(() => recipients.filter(sendable), [recipients]);
  const targets = useMemo(() =>
    allowed.filter(person => selected[person.contactId]), [allowed, selected]);
  const held = recipients.filter(person => !sendable(person));

  const chooseFile = event => {
    const chosen = event.target.files?.[0] || null;
    setError("");
    if (chosen && (
      !["image/jpeg", "image/png"].includes(chosen.type) ||
      chosen.size <= 0 || chosen.size > 5 * 1024 * 1024
    )) {
      setFile(null);
      setError("Choose the latest RM388 JPG/PNG graphic (maximum 5 MB).");
      event.target.value = "";
      return;
    }
    setFile(chosen);
  };

  async function start() {
    if (sending || targets.length === 0 || !file ||
        !billingApproved || !consentReviewed) return;
    if (!window.confirm(
      `Send the 11.11 RM388 MARKETING template to ${targets.length} selected customers?\n\nMeta may charge for these sends. Each contact will be checked again. No automatic retries will occur.`
    )) return;

    setSending(true);
    setError("");
    setResults([]);
    stopRef.current = false;
    try {
      // A stale browser tab cannot turn an earlier preview into authority.
      const checked = await api.getPromotionalBlastPreview();
      const fresh = new Map((checked.recipients || []).map(p => [p.contactId, p]));
      if (targets.some(person => !fresh.has(person.contactId) ||
          !sendable(fresh.get(person.contactId)) ||
          fresh.get(person.contactId).senderId !== person.senderId)) {
        throw new Error("Recipient eligibility changed. Refresh the list and review again. No sends were started.");
      }

      for (const person of targets) {
        if (stopRef.current) break;
        const languageCode = languages[person.contactId] || "zh_CN";
        try {
          // The existing Inbox catalog issues a per-contact billing review.
          // The current Meta-approved IMAGE template must be present on the
          // correct sending number before claiming the recipient.
          const catalog = await api.listWhatsAppTemplates(person.contactId, { force: true });
          const version = (catalog.templates || []).find(template =>
            template.name === CAMPAIGN && template.language === languageCode &&
            template.category === "MARKETING" && template.sendable === true &&
            template.header?.format === "IMAGE"
          );
          const token = catalog.billingAdvisory?.reviewTokens?.[`${CAMPAIGN}::${languageCode}`];
          if (!version || !token || catalog.eligibility?.allowed !== true) {
            throw new Error("Template, sender or billing review unavailable. No message sent.");
          }

          await api.claimPromotionalBlastRecipient({
            campaignKey: CAMPAIGN,
            contactId: person.contactId,
            languageCode,
            billingAcknowledged: true,
            marketingConsentReviewed: true,
          });

          const response = await api.sendWhatsAppTemplate(person.contactId, {
            templateName: CAMPAIGN,
            languageCode,
            values: {},
            marketingConsentConfirmed: true,
            billingAcknowledged: true,
            billingReviewToken: token,
            blastCampaignKey: CAMPAIGN,
          }, file);
          const accepted = Boolean(response.whatsapp_message_id) &&
            !["unknown", "failed", "cancelled"].includes(response.delivery_status);
          if (!accepted) {
            throw new Error("WhatsApp acceptance not confirmed. Review Inbox; this blast will not retry.");
          }

          setResults(current => [...current, {
            id: person.contactId, name: person.name, state: "accepted",
            message: "Accepted by WhatsApp; delivery is not yet confirmed.",
          }]);
        } catch (err) {
          setResults(current => [...current, {
            id: person.contactId, name: person.name, state: "review",
            message: err.message || "Unknown result. Check Inbox before any further action.",
          }]);
          // A failed/uncertain submission can have reached Meta, and a sender
          // billing gate may now be unsettled. Stop the entire batch.
          setError("Campaign paused. Check the last contact in Inbox before starting another batch.");
          break;
        }
      }
    } catch (err) {
      setError(err.message || "Blast was not started.");
    } finally {
      setSending(false);
      stopRef.current = false;
    }
  }

  return (
    <main className="h-full overflow-y-auto bg-[var(--color-bg)] p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5 pb-16">
        <header className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">WhatsApp marketing</p>
          <h1 className="font-display text-2xl font-bold">Promotional Blast</h1>
          <p className="max-w-3xl text-sm text-[var(--color-text-muted)]">
            Preview opted-in Click-to-WhatsApp ad leads, choose their language and send one approved
            image template per customer. The 11.11 offer is valid until 30 November 2026.
            Even a verified ad window does not guarantee free Meta messaging.
          </p>
        </header>

        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-3">
          <h2 className="font-bold">11.11 · 3D 小颜术 RM388</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Template: <code>{CAMPAIGN}</code> · Both WhatsApp numbers · Chinese / English / Malay
          </p>
          <label className="block text-sm font-semibold">
            Upload the latest RM388 promotional graphic once
            <input
              className="mt-2 block w-full rounded-lg border border-[var(--color-border)] p-2 text-sm"
              type="file" accept="image/jpeg,image/png" onChange={chooseFile} disabled={sending}
            />
          </label>
          {file && <p className="text-xs text-[var(--color-text-muted)]">Selected: {file.name}</p>}
          <p className="text-xs text-[var(--color-text-muted)]">
            The image is reused for the selected customers, but uploaded separately through the
            correct WhatsApp account's existing sending path.
          </p>
        </section>

        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-bold">Verified recipients</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                {allowed.length} pass initial filters · {held.length} held · {targets.length} selected
              </p>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={loading || sending} onClick={() => {
                setSelected(Object.fromEntries(allowed.map(p => [p.contactId, true])));
              }} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-semibold">
                Select eligible
              </button>
              <button type="button" disabled={loading || sending} onClick={() => void refresh()}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-semibold">
                {loading ? "Checking…" : "Refresh"}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full min-w-[650px] text-left text-sm">
              <thead className="bg-[var(--color-bg)] text-xs">
                <tr>
                  <th className="p-3">Send</th><th className="p-3">Customer</th>
                  <th className="p-3">WhatsApp</th><th className="p-3">Interest</th>
                  <th className="p-3">Language</th><th className="p-3">Deadline (MYT)</th>
                </tr>
              </thead>
              <tbody>
                {recipients.map(person => (
                  <tr key={person.contactId} className="border-t border-[var(--color-border)]">
                    <td className="p-3">
                      <input type="checkbox" aria-label={`Send to ${person.name}`}
                        disabled={sending || !sendable(person)}
                        checked={Boolean(selected[person.contactId]) && sendable(person)}
                        onChange={event => setSelected(s => ({ ...s, [person.contactId]: event.target.checked }))}/>
                    </td>
                    <td className="p-3">
                      <Link className="font-semibold underline" to={`/inbox?contact=${person.contactId}`}>
                        {person.name}
                      </Link>
                      {person.blockedReason && <p className="text-xs text-amber-700">
                        {person.blockedReason === "secondary_billing_unresolved"
                          ? "Secondary billing review needed" : "Billing alarm, hold"}
                      </p>}
                      {person.alreadyClaimed && <p className="text-xs text-[var(--color-text-muted)]">Already claimed</p>}
                    </td>
                    <td className="p-3">{person.senderId === 2 ? "Secondary" : "Primary"}</td>
                    <td className="p-3">{person.treatmentInterest}</td>
                    <td className="p-3">
                      <select aria-label={`Language for ${person.name}`}
                        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
                        value={languages[person.contactId] || person.suggestedLanguage || "zh_CN"}
                        disabled={sending || !sendable(person)}
                        onChange={event => setLanguages(s => ({ ...s, [person.contactId]: event.target.value }))}>
                        {LANGUAGES.map(lang => <option key={lang.value} value={lang.value}>{lang.label}</option>)}
                      </select>
                    </td>
                    <td className="p-3 whitespace-nowrap">{fmtTime(person.expiresAt)}</td>
                  </tr>
                ))}
                {!recipients.length && <tr><td className="p-4 text-[var(--color-text-muted)]" colSpan={6}>
                  {loading ? "Checking customers…" : "No matching contacts or the eligibility check failed."}
                </td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Eligibility is rechecked at claim time and immediately before sending.
            Staff-owned, booked, opted-out, inactive or recently messaged chats are excluded.
            A billing issue on the secondary number puts its recipients on hold.
          </p>
        </section>

        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-4">
          <h2 className="font-bold">Final review</h2>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" disabled={sending} checked={consentReviewed}
              onChange={event => setConsentReviewed(event.target.checked)} />
            <span>I reviewed these contacts and their recorded permission for related WhatsApp promotions.</span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" disabled={sending} checked={billingApproved}
              onChange={event => setBillingApproved(event.target.checked)} />
            <span>I understand Meta may charge for every MARKETING template, even during an ad-originated free-entry period.</span>
          </label>
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => void start()}
              disabled={sending || loading || !file || !targets.length || !billingApproved || !consentReviewed}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
              {sending ? "Sending one at a time…" : `Review and send ${targets.length} selected`}
            </button>
            {sending && <button type="button" onClick={() => { stopRef.current = true; }}
              className="rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
              Stop after current contact
            </button>}
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            A claim is one-time and cannot be replayed. If a send fails or its status is uncertain,
            the batch stops and you should inspect that customer's Inbox before doing anything else.
            Closing this tab also stops sending further recipients.
          </p>
        </section>

        {results.length > 0 && (
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
            <h2 className="mb-3 font-bold">This session</h2>
            {results.map(item => <p key={item.id} className="border-t border-[var(--color-border)] py-2 text-sm">
              <strong>{item.name}</strong>: {item.message}
            </p>)}
          </section>
        )}
      </div>
    </main>
  );
}
