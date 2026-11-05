import {useCallback,useEffect,useState} from "react";
import {api} from "../api";

// No resend button. Expired images and uncertain follow-ups require
// staff verification before any new customer message.
export default function ArielMediaReview(){
 const [data,setData]=useState(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const load=useCallback(async()=>{
   setLoading(true);setError("");
   try{setData(await api.getSecondaryMediaReview());}
   catch(e){setError(e?.message||"Could not verify sender media status.");}
   finally{setLoading(false);}
 },[]);
 useEffect(()=>{void load();},[load]);
 if(data && !data.configured && !error)return null;
 const entries=data?.items||[];
 const senderName=data?.senderDisplayName||"Secondary WhatsApp";
 return <section aria-label="Secondary WhatsApp media review"
   className="mb-5 rounded-xl border border-[var(--color-border)] p-4">
   <div className="flex flex-wrap justify-between items-center gap-2">
     <div>
       <h3 className="text-sm font-semibold">{senderName} — delivery review</h3>
       <p className="text-xs text-[var(--color-text-muted)] mt-1">
         Review expired images, unconfirmed follow-ups, Business App attachments and history imports.
         Nothing on this page sends or retries a customer message.
       </p>
     </div>
     <button type="button" disabled={loading} onClick={()=>void load()}
       className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
       {loading?"Checking…":"Refresh"}
     </button>
   </div>
   {error?<p role="alert" className="text-xs text-red-600 mt-2">{error}</p>:null}
   {!error&&!loading&&entries.length===0?
     <p className="mt-3 text-xs text-[var(--color-text-muted)]">
       No unresolved secondary-number media incidents.
     </p>:null}
   {entries.length>0?<div className="overflow-x-auto mt-3">
     <table className="min-w-full text-xs text-left">
       <thead><tr className="border-b border-[var(--color-border)]">
         <th className="py-2 pr-3">Source</th><th className="py-2 pr-3">Contact</th>
         <th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Updated</th>
         <th className="py-2">Required review</th>
       </tr></thead>
       <tbody>{entries.map(item=><tr key={item.type+item.id}
         className="border-b border-[var(--color-border)]/40 align-top">
         <td className="py-2 pr-3">{item.type==="outbound_ai_image"
           ?item.media_kind==="result"?"Before & After image":item.media_kind==="promotion"?"Promo image":"Automated image"
           :item.type==="outbound_followup"?"2h/6h/20h follow-up"
           :item.type==="outbound_marketing_followup"?"Marketing follow-up"
           :item.type==="business_app_history"?"History sync":"WhatsApp Business App"}</td>
         <td className="py-2 pr-3">{item.contact_id? "#"+item.contact_id:"—"}</td>
         <td className="py-2 pr-3">{item.status}</td>
         <td className="py-2 pr-3">{item.updated_at?
           new Date(item.updated_at).toLocaleString("en-MY"): "—"}</td>
         <td className="py-2">{item.action}</td>
       </tr>)}</tbody>
     </table>
   </div>:null}
 </section>;
}
