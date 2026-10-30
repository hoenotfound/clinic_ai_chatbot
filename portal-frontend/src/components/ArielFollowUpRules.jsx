import { useEffect, useState } from "react";
import { api } from "../api";

const SLOTS=[2,6,20];
const fallback={2:"",6:"",20:""};

export default function ArielFollowUpRules(){
  const [rules,setRules]=useState(fallback);
  const [enabled,setEnabled]=useState({2:false,6:false,20:false});
  const [videos,setVideos]=useState({2:"",6:""});
  const [mediaApproved,setMediaApproved]=useState({2:false,6:false});
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
      setVideos(Object.fromEntries([2,6].map(slot=>[
        slot,data.rules?.find(x=>Number(x.slot_hours)===slot)?.media_key||"",
      ])));
      setMediaApproved({2:false,6:false});
    }).catch(e=>{if(active)setError(e.message||"Could not load secondary WhatsApp settings.");});
    return()=>{active=false;};
  },[]);
  async function save(slot){
    setBusy(slot);setError("");setSaved(null);
    try{
      const selected=slot===20?"":videos[slot];
      if(selected && !mediaApproved[slot])throw Error("Approve this exact clinic video before saving.");
      const data=await api.saveSecondaryFollowUpRule(slot,{
        messageText:rules[slot],enabled:enabled[slot],
        ...(selected?{mediaKey:selected,mediaType:"video",
          confirmClinicVideoReuse:true}:{}),
      });
      setEnabled(prev=>({...prev,[slot]:data.rule.enabled}));
      if(slot!==20)setMediaApproved(prev=>({...prev,[slot]:false}));
      setSaved(slot);
    }catch(e){setError(e.message||"Unable to save secondary follow-up.");}
    finally{setBusy(null);}
  }
  const senderName=config?.senderDisplayName || "Secondary WhatsApp";
  return (
    <section aria-label="Secondary WhatsApp follow-ups"
      className="mb-5 rounded-2xl border-2 border-[var(--color-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">{senderName} — separate WhatsApp follow-ups</h2>
        <span className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold">
          {!config?.configured?"Sender not activated":config?.workerEnabled?"Worker enabled":"Worker disabled"}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
        These 2h / 6h / 20h rules belong only to the verified secondary number.
        Changes here never affect Neutro Sense. Only opted-in customers inside a verified 24-hour window
        may receive these messages. Quiet hours: 00:00–07:00 Malaysia time.
      </p>
      {error&&<p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">{error}</p>}
      {!config ? <p className="mt-3 text-xs">Checking sender settings…</p> :
      !config.configured ?
        <p className="mt-3 rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs">
          The secondary WhatsApp number is not yet verified and active, or sender-aware
          mode is disabled. Follow-ups cannot be configured or sent yet.
        </p> :
      <div className="mt-4 space-y-4">
        {SLOTS.map(slot=>
          <div key={slot} className="rounded-xl border border-[var(--color-border)] p-3">
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
            <textarea id={`secondary-followup-${slot}`} rows={2} maxLength={1024}
              value={rules[slot]} onChange={e=>setRules(prev=>({...prev,[slot]:e.target.value}))}
              placeholder="Write and approve the exact message for this phone number"
              className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs" />
            {(slot===2||slot===6)&&config?.mediaEnabled&&
              <div className="mt-3 rounded-lg border border-[var(--color-border)] p-2">
                <label htmlFor={`secondary-video-${slot}`} className="block text-xs font-semibold">
                  Optional clinic follow-up video
                </label>
                <select id={`secondary-video-${slot}`} value={videos[slot]||""}
                  onChange={e=>{
                    setVideos(prev=>({...prev,[slot]:e.target.value}));
                    setMediaApproved(prev=>({...prev,[slot]:false}));
                  }}
                  className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-white px-2 py-2 text-xs">
                  <option value="">Text only (no video)</option>
                  {(config.availableClinicVideos||[]).map(item=>
                    <option key={item.key} value={item.key}>{item.label}</option>
                  )}
                </select>
                {videos[slot]&&
                  <label className="mt-2 flex items-start gap-2 text-xs">
                    <input type="checkbox" checked={mediaApproved[slot]||false}
                      onChange={e=>setMediaApproved(prev=>({...prev,[slot]:e.target.checked}))}/>
                    <span>I approve this clinic-owned video for opted-in customers on the second WhatsApp.</span>
                  </label>}
              </div>}
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {saved===slot?"Saved to secondary number only":
                  videos[slot]?"Video requires explicit approval and separate Meta receipts":
                    "Text-only; no media is sent"}
              </span>
              <button type="button" onClick={()=>save(slot)}
                disabled={busy!==null||rules[slot].trim().length<3||
                  ((slot===2||slot===6)&&Boolean(videos[slot])&&!mediaApproved[slot])}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                {busy===slot?"Saving…":"Save secondary rule"}
              </button>
            </div>
          </div>
        )}
      </div>}
      {config?.configured&&!config.workerEnabled&&
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          These saved settings cannot send anything until this number's separate
          operational switch and real Meta validation are enabled.
        </p>}
    </section>
  );
}
