import { useEffect, useState } from "react";
import { api } from "../api";

const SLOTS=[2,6,20];
const fallback={2:"",6:"",20:""};

export default function ArielFollowUpRules(){
  const [rules,setRules]=useState(fallback);
  const [enabled,setEnabled]=useState({2:false,6:false,20:false});
  const [config,setConfig]=useState(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(null);
  const [saved,setSaved]=useState(null);

  useEffect(()=>{
    let active=true;
    api.getSecondaryFollowUpRules().then(data=>{
      if(!active)return;
      setConfig(data);
      setRules(Object.fromEntries(SLOTS.map(slot=>[
        slot,data.rules?.find(x=>Number(x.slot_hours)===slot)?.message_text||"",
      ])));
      setEnabled(Object.fromEntries(SLOTS.map(slot=>[
        slot,data.rules?.find(x=>Number(x.slot_hours)===slot)?.enabled===true,
      ])));
    }).catch(e=>{if(active)setError(e.message||"Could not load Ariel settings.");});
    return()=>{active=false;};
  },[]);
  async function save(slot){
    setBusy(slot);setError("");setSaved(null);
    try{
      const data=await api.saveSecondaryFollowUpRule(slot,{
        messageText:rules[slot],enabled:enabled[slot],
      });
      setEnabled(prev=>({...prev,[slot]:data.rule.enabled}));
      setSaved(slot);
    }catch(e){setError(e.message||"Unable to save Ariel follow-up.");}
    finally{setBusy(null);}
  }
  return (
    <section aria-label="Ariel independent WhatsApp follow-ups"
      className="mb-5 rounded-2xl border-2 border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">Ariel Lee — separate WhatsApp follow-ups</h2>
        <span className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold">
          {!config?.configured?"Sender not activated":config?.workerEnabled?"Worker enabled":"Worker disabled"}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
        These are Ariel-only 2h / 6h / 20h messages. Changes here never affect
        Neutro Sense. Only opted-in customers inside a verified 24-hour window
        may receive these messages. Quiet hours: 00:00–07:00 Malaysia time.
      </p>
      {error&&<p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">{error}</p>}
      {!config ? <p className="mt-3 text-xs">Checking sender settings…</p> :
      !config.configured ?
        <p className="mt-3 rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs">
          Ariel's verified WhatsApp account is not registered or sender-aware
          mode is disabled. Follow-ups cannot be configured or sent yet.
        </p> :
      <div className="mt-4 space-y-4">
        {SLOTS.map(slot=>
          <div key={slot} className="rounded-xl border border-[var(--color-border)] p-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`ariel-followup-${slot}`} className="text-sm font-semibold">
                After {slot} hours
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={enabled[slot]}
                  onChange={e=>setEnabled(prev=>({...prev,[slot]:e.target.checked}))} />
                Enabled
              </label>
            </div>
            <textarea id={`ariel-followup-${slot}`} rows={2} maxLength={1024}
              value={rules[slot]} onChange={e=>setRules(prev=>({...prev,[slot]:e.target.value}))}
              placeholder="Write and approve the exact Ariel customer message"
              className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs" />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {saved===slot?"Saved to Ariel only":"Text-only rule; media must be separately sender-approved"}
              </span>
              <button type="button" onClick={()=>save(slot)}
                disabled={busy!==null||rules[slot].trim().length<3}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                {busy===slot?"Saving…":"Save Ariel rule"}
              </button>
            </div>
          </div>
        )}
      </div>}
      {config?.configured&&!config.workerEnabled&&
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          These saved settings cannot send anything until Ariel's separate
          operational switch and real Meta validation are enabled.
        </p>}
    </section>
  );
}
