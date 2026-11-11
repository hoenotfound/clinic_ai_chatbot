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
  const [campaigns,setCampaigns]=useState([]);
  const [campaignKey,setCampaignKey]=useState(CAMPAIGN);
  const [newCampaign,setNewCampaign]=useState({
    campaignKey:"",title:"",templateName:"",promotedTreatment:"3D 小颜术",
    targetTreatments:"3D 小颜术",validUntil:"",
  });
  const [creating,setCreating]=useState(false);
  const [relatedReview,setRelatedReview]=useState({});
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
  const currentCampaign=campaigns.find(item=>item.campaignKey===campaignKey) || null;

  const reloadCampaigns=useCallback(async()=>{
    const data=await api.getPromotionalBlastCampaigns();
    setCampaigns(data.campaigns||[]);
  },[]);

  async function createNewCampaign(event){
    event.preventDefault();
    if(creating||sending)return;
    setCreating(true);setError("");
    try{
      const payload={
        ...newCampaign,
        targetTreatments:newCampaign.targetTreatments.split(",").map(v=>v.trim()).filter(Boolean),
        validUntil:new Date(newCampaign.validUntil).toISOString(),
      };
      const created=await api.createPromotionalBlastCampaign(payload);
      await reloadCampaigns();
      setCampaignKey(created.campaignKey);
      setFile(null);setRecipients([]);setSelected({});setRelatedReview({});
      setBillingApproved(false);setConsentReviewed(false);
      setNewCampaign({
        campaignKey:"",title:"",templateName:"",promotedTreatment:"3D 小颜术",
        targetTreatments:"3D 小颜术",validUntil:"",
      });
    }catch(err){setError(err.message||"Could not create this campaign.")}
    finally{setCreating(false);}
  }

  const refresh = useCallback(async (key=campaignKey) => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getPromotionalBlastPreview(key);
      if (data.campaignKey !== key) throw new Error("Campaign configuration changed.");
      setRecipients(data.recipients || []);
      setSelected({});
      setRelatedReview({});
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
  }, [campaignKey]);

  useEffect(()=>{void reloadCampaigns().catch(err=>setError(err.message));},[reloadCampaigns]);
  useEffect(() => { void refresh(campaignKey); }, [campaignKey,refresh]);

  const allowed = useMemo(() => recipients.filter(sendable), [recipients]);
  const targets = useMemo(() =>
    allowed.filter(person => selected[person.contactId] &&
      (!person.relatedOfferReviewRequired || relatedReview[person.contactId])),
    [allowed,selected,relatedReview]);
  const held = recipients.filter(person => !sendable(person));

  const chooseFile = event => {
    const chosen = event.target.files?.[0] || null;
    setError("");
    if (chosen && (
      !["image/jpeg", "image/png"].includes(chosen.type) ||
      chosen.size <= 0 || chosen.size > 5 * 1024 * 1024
    )) {
      setFile(null);
      setError("Choose a JPG/PNG promotional graphic (maximum 5 MB).");
      event.target.value = "";
      return;
    }
    setFile(chosen);
  };

  async function start() {
    if (sending || targets.length === 0 || !file || !currentCampaign ||
        !billingApproved || !consentReviewed) return;
    if (!window.confirm(
      `Send "${currentCampaign.title}" to ${targets.length} selected customers?\n\nMeta may charge for these sends. Each contact will be checked again. No automatic retries will occur.`
    )) return;

    setSending(true);
    setError("");
    setResults([]);
    stopRef.current = false;
    try {
      // A stale browser tab cannot turn an earlier preview into authority.
      const checked = await api.getPromotionalBlastPreview(campaignKey);
      const fresh = new Map((checked.recipients || []).map(p => [p.contactId, p]));
      if (targets.some(person => !fresh.has(person.contactId) ||
          !sendable(fresh.get(person.contactId)) ||
          fresh.get(person.contactId).senderId !== person.senderId ||
          (fresh.get(person.contactId).relatedOfferReviewRequired &&
           !relatedReview[person.contactId]))) {
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
            template.name === currentCampaign.templateName && template.language === languageCode &&
            template.category === "MARKETING" && template.sendable === true &&
            template.header?.format === "IMAGE"
          );
          const token = catalog.billingAdvisory?.reviewTokens?.[`${currentCampaign.templateName}::${languageCode}`];
          if (!version || !token || catalog.eligibility?.allowed !== true) {
            throw new Error("Template, sender or billing review unavailable. No message sent.");
          }

          const claim=await api.claimPromotionalBlastRecipient({
            campaignKey,
            contactId: person.contactId,
            languageCode,
            billingAcknowledged: true,
            marketingConsentReviewed: true,
            relatedOfferReviewed:person.relatedOfferReviewRequired===true &&
              relatedReview[person.contactId]===true,
          });
          if(!claim.reservationToken)throw new Error("No reservation token returned. No message was started.");

          const response = await api.sendWhatsAppTemplate(person.contactId, {
            templateName: currentCampaign.templateName,
            languageCode,
            values: {},
            marketingConsentConfirmed: true,
            billingAcknowledged: true,
            billingReviewToken: token,
            blastCampaignKey: campaignKey,
            blastReservationToken: claim.reservationToken,
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
            image template per customer. Existing free-entry and marketing-consent rules apply.
            Verified ad history does not guarantee free Meta messaging.
          </p>
        </header>

        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-3">
          <h2 className="font-bold">Campaign</h2>
          <label className="block text-sm font-semibold">
            Select an existing campaign
            <select value={campaignKey} disabled={sending}
              onChange={event=>{
                setCampaignKey(event.target.value);
                setFile(null);setSelected({});setRelatedReview({});
                setBillingApproved(false);setConsentReviewed(false);
              }}
              className="mt-2 block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
              {!campaigns.some(item=>item.campaignKey===campaignKey)&&<option value={campaignKey}>{campaignKey}</option>}
              {campaigns.map(item=><option key={item.campaignKey} value={item.campaignKey}>
                {item.title} · {item.templateName}
              </option>)}
            </select>
          </label>
          {currentCampaign&&<p className="text-xs text-[var(--color-text-muted)]">
            Template: <code>{currentCampaign.templateName}</code> · Promoted treatment: {currentCampaign.promotedTreatment}
            · Ends: {fmtTime(currentCampaign.validUntil)}
          </p>}
          <details className="rounded-lg border border-[var(--color-border)] p-3">
            <summary className="cursor-pointer font-semibold text-sm">Create a future campaign</summary>
            <form onSubmit={createNewCampaign} className="mt-3 grid gap-3 sm:grid-cols-2">
              {[
                ["campaignKey","Unique campaign key (lowercase)", "ns_next_promo_2026"],
                ["title","Campaign title","Example: December Facial Special"],
                ["templateName","Approved MARKETING template name","ns_new_facial_offer"],
                ["promotedTreatment","Promoted treatment","3D 小颜术"],
                ["targetTreatments","Eligible treatment interests (comma separated)","3D 小颜术, 9D 逆龄抗衰"],
              ].map(([field,label,placeholder])=>
                <label key={field} className="text-sm">{label}
                  <input required value={newCampaign[field]} placeholder={placeholder}
                    disabled={creating||sending}
                    onChange={e=>setNewCampaign(v=>({...v,[field]:e.target.value}))}
                    className="mt-1 block w-full rounded-lg border border-[var(--color-border)] p-2"/>
                </label>)}
              <label className="text-sm">Offer valid until (local date/time)
                <input required type="datetime-local" value={newCampaign.validUntil}
                  disabled={creating||sending}
                  onChange={e=>setNewCampaign(v=>({...v,validUntil:e.target.value}))}
                  className="mt-1 block w-full rounded-lg border border-[var(--color-border)] p-2"/>
              </label>
              <button className="rounded-lg border border-[var(--color-border)] px-4 py-2 font-semibold text-sm"
                type="submit" disabled={creating||sending}>
                {creating?"Creating…":"Save campaign (does not send)"}
              </button>
            </form>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              Enter the exact Meta-approved template name. Each contact's sender-specific approval
              is checked before sending. Campaign definitions are not editable after creation.
            </p>
          </details>
          <label className="block text-sm font-semibold">
            Upload this campaign's promotional graphic once
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
                setSelected(Object.fromEntries(allowed
                  .filter(p=>!p.relatedOfferReviewRequired||relatedReview[p.contactId]===true)
                  .map(p => [p.contactId, true])));
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
                        disabled={sending || !sendable(person) ||
                          (person.relatedOfferReviewRequired && !relatedReview[person.contactId])}
                        checked={Boolean(selected[person.contactId]) && sendable(person) &&
                          (!person.relatedOfferReviewRequired || relatedReview[person.contactId])}
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
                      {person.alreadyClaimed && <p className="text-xs text-[var(--color-text-muted)]">Reserved or already sent</p>}
                      {person.relatedOfferReviewRequired && <label className="mt-1 flex items-center gap-1 text-xs">
                        <input type="checkbox"
                          aria-label={`Confirm related facial offer consent for ${person.name}`}
                          disabled={sending||!sendable(person)}
                          checked={relatedReview[person.contactId]===true}
                          onChange={e=>{
                            setRelatedReview(v=>({...v,[person.contactId]:e.target.checked}));
                            if(!e.target.checked)setSelected(v=>({...v,[person.contactId]:false}));
                          }}/>
                        Reviewed consent: a different treatment offer
                      </label>}
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
            Secondary billing holds are checked per customer. Sender-wide billing alarms
            still stop the number. Quiet hours from Tools are respected.
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
            An unused claim expires after five minutes and may be reserved again, but
            once a provider attempt starts it cannot be replayed. If delivery is uncertain,
            the batch stops and you should inspect the conversation in Inbox.
            Closing this tab stops further recipients.
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
