import { useEffect, useState } from "react";
import { api } from "../api";

const SLOTS=[2,6,20];
const MARKETING_SLOTS=[48,66,96,144];
const EXTENDED_TEMPLATES={96:"ns_day4_checkin",144:"ns_day6_invitation"};
const marketingSlotLabel=slot=>slot===96?"Day 4 (96 hours)":slot===144?"Day 6 (144 hours)":`After ${slot} hours`;
const newMarketingState=()=>Object.fromEntries(MARKETING_SLOTS.map(slot=>[slot,{
  templates:{zh_CN:"",en_US:"",ms:""},enabled:false,approved:false,
}]));

export default function ArielFollowUpRules({ active = true, section = "service" }){
  const [enabled,setEnabled]=useState({2:false,6:false,20:false});
  const [config,setConfig]=useState(null);
  const [marketing,setMarketing]=useState(newMarketingState);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(null);
  const [saved,setSaved]=useState(null);

  useEffect(()=>{
    if(!active||config)return;
    let mounted=true;
    api.getSecondaryFollowUpRules().then(data=>{
      if(!mounted)return;
      setConfig(data);
      setEnabled(Object.fromEntries(SLOTS.map(slot=>[
        slot,data.rules?.find(x=>Number(x.slot_hours)===slot)?.enabled===true,
      ])));
      setMarketing(Object.fromEntries(MARKETING_SLOTS.map(slot=>{
        const saved=(data.marketingRules||[]).filter(r=>Number(r.slot_hours)===slot);
        return [slot,{
          templates:Object.fromEntries(["zh_CN","en_US","ms"].map(lang=>[
            lang,saved.find(r=>r.language_code===lang)?.template_name||"",
          ])),
          enabled:saved.some(r=>r.enabled===true),approved:false,
        }];
      })));
    }).catch(e=>{if(mounted)setError(e.message||"Could not load secondary WhatsApp settings.");});
    return()=>{mounted=false;};
  },[active,config]);
  async function save(slot){
    setBusy(slot);setError("");setSaved(null);
    try{
      const data=await api.saveSecondaryFollowUpRule(slot,{enabled:enabled[slot]});
      setEnabled(prev=>({...prev,[slot]:data.rule.enabled}));
      setConfig(prev=>prev?({...prev,rules:[
        ...(prev.rules||[]).filter(item=>Number(item.slot_hours)!==slot),
        data.rule,
      ]}):prev);
      setSaved(slot);
    }catch(e){setError(e.message||"Unable to save secondary follow-up.");}
    finally{setBusy(null);}
  }
  async function saveMarketing(slot){
    const row=marketing[slot];
    const variants=Object.entries(row.templates).filter(([,name])=>Boolean(name))
      .map(([languageCode,name])=>({name,languageCode}));
    if(row.enabled && (!variants.length || !row.approved))
      return setError("Choose and approve each intended marketing language.");
    setBusy(slot);setError("");setSaved(null);
    try{
      const data=await api.saveSecondaryMarketingFollowUpRule(slot,{
        variants,enabled:row.enabled,
        operatorBillingApproved:row.enabled && row.approved===true,
      });
      setMarketing(prev=>({...prev,[slot]:{
        ...prev[slot],
        enabled:(data.rules||[]).some(r=>r.enabled===true),
        approved:false,
      }}));
      setConfig(prev=>prev?({...prev,marketingRules:[
        ...(prev.marketingRules||[]).filter(item=>Number(item.slot_hours)!==slot),
        ...(data.rules||[]),
      ]}):prev);
      setSaved(slot);
    }catch(e){setError(e.message||"Unable to save the verified secondary templates.");}
    finally{setBusy(null);}
  }
  const senderName=config?.senderDisplayName || "Secondary WhatsApp";
  return (
    <section aria-label="Secondary WhatsApp follow-ups"
      className="rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold">{section === "marketing" ? "Extended marketing templates" : "Reply-window follow-up messages"}</h2>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">For {senderName} only</p>
        </div>
        <span className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold">
          {!config ? "Checking connection" : !config.configured ? "Number unavailable" :
            section === "marketing" ? (config.marketingWorkerEnabled ? "Marketing worker on" : "Marketing worker off") :
            (config.workerEnabled ? "Reply worker on" : "Reply worker off")}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
        {section === "marketing"
          ? "48h, 66h, Day 4 and Day 6 templates belong to this number only. Each language requires Meta approval, treatment-specific marketing consent and its own sending switch."
          : "These messages use the primary clinic\u0027s approved translations and matching treatment videos when available. Only eligible secondary ad enquiries are followed up within the verified 24-hour reply window. Quiet hours: 00:00–07:00 Malaysia time."}
      </p>
      {error&&<p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">{error}</p>}
      {!config ? <p className="mt-3 text-xs">Checking sender settings…</p> :
      !config.configured ?
        <p className="mt-3 rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs">
          The secondary WhatsApp number is not yet verified and active, or sender-aware
          mode is disabled. Follow-ups cannot be configured or sent yet.
        </p> :
      section === "service" ? <div className="mt-4 space-y-3">
        {SLOTS.map(slot=>{
          const current=config.rules?.find(item=>Number(item.slot_hours)===slot);
          const inherited=config.primaryFollowUpMessages?.[slot]||"";
          const dirty=enabled[slot] !== (current?.enabled===true);
          return <details key={slot} className="group overflow-hidden rounded-xl border border-[var(--color-border)] bg-white">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
              <span>After {slot} hours</span>
              <span className="text-xs text-[var(--color-text-muted)]">{dirty ? "Unsaved" : enabled[slot] ? "On" : "Off"} · <span className="group-open:hidden">Edit</span><span className="hidden group-open:inline">Close</span></span>
            </summary>
            <div className="border-t border-[var(--color-border)] p-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`secondary-followup-${slot}`} className="text-sm font-semibold">
                After {slot} hours
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={enabled[slot]}
                  onChange={e=>setEnabled(prev=>({...prev,[slot]:e.target.checked}))} />
                Enabled
              </label>
            </div>
            <textarea id={`secondary-followup-${slot}`} rows={3}
              value={inherited} readOnly aria-readonly="true"
              className="mt-2 min-h-24 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm text-[var(--color-text-muted)]" />
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
              Message content and treatment-specific translations are inherited from Primary WhatsApp.
              Edit the primary follow-up settings to change the wording on both numbers.
              {slot===20&&" When secondary 20h AI personalization is enabled, it creates a contextual message instead."}
            </p>
            {(slot===2||slot===6)&&
              <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
                {config.mediaEnabled
                  ? "The correct approved treatment video is chosen automatically from the primary clinic library. No separate secondary video is required."
                  : "Treatment videos are unavailable until the secondary account's own media approval and sending checks are enabled."}
              </p>}
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {dirty ? "Changes not saved" : saved===slot ? "Saved to secondary number" :
                  "Primary content shared"}
              </span>
              <button type="button" onClick={()=>save(slot)}
                disabled={busy!==null||(enabled[slot]&&inherited.length<3)}
                className="min-h-11 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                {busy===slot?"Saving…":"Save sender switch"}
              </button>
            </div>
            </div>
          </details>;
        })}
      </div> : null}
      {config?.configured && section === "marketing" &&
        <div className="mt-4">
          <h3 className="text-sm font-bold">Approved templates</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            These are paid marketing templates for the second number only.
            No message is sent without an approved account template, explicit
            customer marketing consent and an independently enabled worker.
            Imported conversations do not count as consent.
          </p>
          {!config.marketingCatalogAvailable&&
            <p className="mt-2 text-xs" role="status">
              Meta template catalog is unavailable. Saving is disabled.
            </p>}
          {config.marketingCatalogAvailable&&!(config.marketingTemplates||[]).length&&
            <p className="mt-2 text-xs" role="status">
              No approved text-only marketing templates on the second account yet.
              Submit and get them approved in Meta first.
            </p>}
          {!config.extendedWorkerEnabled&&<p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Day 4 and Day 6 sending is separately disabled on the server. Saving a template never enables that server switch.
          </p>}
          {MARKETING_SLOTS.map(slot=>{
            const row=marketing[slot];
            const choices=(config.marketingTemplates||[]).filter(t=>
              !EXTENDED_TEMPLATES[slot]||t.name===EXTENDED_TEMPLATES[slot]);
            const languages=[["zh_CN","Chinese"],["en_US","English"],["ms","Malay"]];
            const selected=languages.map(([locale])=>choices.find(t=>
              t.languageCode===locale&&t.name===row.templates[locale])).filter(Boolean);
            const selectedCount=languages.filter(([locale])=>Boolean(row.templates[locale])).length;
            const validSelection=selectedCount>0&&selected.length===selectedCount;
            const savedRows=(config.marketingRules||[]).filter(item=>Number(item.slot_hours)===slot);
            const savedEnabled=savedRows.some(item=>item.enabled===true);
            const templateChanged=languages.some(([locale])=>(row.templates[locale]||"") !==
              (savedRows.find(item=>item.language_code===locale)?.template_name||""));
            const dirty=row.enabled!==savedEnabled||templateChanged;
            return <details key={slot} className="group mt-3 overflow-hidden rounded-xl border border-[var(--color-border)] bg-white">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-xs font-semibold [&::-webkit-details-marker]:hidden">
                <span>{marketingSlotLabel(slot)}</span>
                <span className="text-[var(--color-text-muted)]">{dirty ? "Unsaved" : row.enabled ? "On" : "Off"} · <span className="group-open:hidden">Edit</span><span className="hidden group-open:inline">Close</span></span>
              </summary>
              <div className="border-t border-[var(--color-border)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{marketingSlotLabel(slot)}</span>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={row.enabled}
                    disabled={!row.enabled&&(!config.marketingCatalogAvailable||!validSelection)}
                    onChange={e=>setMarketing(p=>({...p,[slot]:{
                      ...p[slot],enabled:e.target.checked,approved:false,
                    }}))}/>
                  Enabled
                </label>
              </div>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Assign an independently approved template per customer language.
                Unconfigured or unclear language is skipped, never translated automatically.
              </p>
              {languages.map(([locale,label])=>{
                const choice=selected.find(t=>t.languageCode===locale);
                return <div key={locale} className="mt-3">
                  <label htmlFor={`secondary-marketing-${slot}-${locale}`}
                    className="block text-xs font-medium">{label} ({locale})</label>
                  <select id={`secondary-marketing-${slot}-${locale}`}
                    value={choice?.name||""}
                    disabled={!config.marketingCatalogAvailable}
                    onChange={e=>setMarketing(p=>({...p,[slot]:{
                      ...p[slot],templates:{...p[slot].templates,[locale]:e.target.value},
                      enabled:false,approved:false,
                    }}))}
                    className="mt-1 min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-white p-2 text-base sm:text-sm">
                    <option value="">No automatic send for {label}</option>
                    {choices.filter(t=>t.languageCode===locale).map(t=>
                      <option key={`${t.name}::${t.languageCode}`} value={t.name}>
                        {t.name} ({t.languageCode})
                      </option>)}
                  </select>
                  {choice&&<p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Approved message: {choice.body}
                  </p>}
                </div>;
              })}
              {row.enabled&&<label className="mt-3 flex items-start gap-2 text-xs">
                <input type="checkbox" checked={row.approved}
                  onChange={e=>setMarketing(p=>({...p,[slot]:{
                    ...p[slot],approved:e.target.checked,
                  }}))}/>
                <span>I approve potential MARKETING charges for each selected,
                  independently Meta-approved language on this secondary WhatsApp.
                  Every recipient still needs explicit treatment-specific marketing consent.
                </span>
              </label>}
              <div className="mt-2 flex justify-between gap-2">
                <span className="text-xs text-[var(--color-text-muted)]">
                  {dirty ? "Changes not saved" : saved===slot ? "Saved to second number" :
                    slot>=96 ? (config.extendedWorkerEnabled ? "Day 4/6 worker enabled" : "Day 4/6 worker off") :
                    config.marketingWorkerEnabled ? "Worker enabled" : "Worker off"}
                </span>
                <button type="button" onClick={()=>saveMarketing(slot)}
                  disabled={busy!==null||(row.enabled&&
                    (!config.marketingCatalogAvailable||!validSelection||!row.approved))}
                  className="min-h-11 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                  {busy===slot?"Saving…":"Save template languages"}
                </button>
              </div>
              </div>
            </details>;
          })}
        </div>}
      {config?.configured && section === "service" && !config.workerEnabled &&
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          These saved settings cannot send anything until this number's separate
          operational switch and real Meta validation are enabled.
        </p>}
      {config?.configured && section === "marketing" && !config.marketingWorkerEnabled && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          The marketing worker is off. Saving templates does not enable sending until that worker and Meta checks allow it.
        </p>
      )}
    </section>
  );
}
