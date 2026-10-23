import {useCallback,useEffect,useState} from "react";
import {api} from "../api";

// Deliberately has NO resend button. An uncertain Meta send must be verified
// against the provider receipt/billing audit before any new customer message.
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
 return <section aria-label="Ariel sender media review"
   className="mb-5 rounded-xl border border-[var(--color-border)] p-4">
   <div className="flex flex-wrap justify-between items-center gap-2">
     <div>
       <h3 className="text-sm font-semibold">Ariel — WhatsApp media review</h3>
       <p className="text-xs text-[var(--color-text-muted)] mt-1">
         Sender-specific Business App attachments and unconfirmed automated pictures.
         Provider acceptance must be confirmed before resending.
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
       No unresolved Ariel media incidents.
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
         <td className="py-2 pr-3">{item.type==="outbound_ai_image"?
           "Automated image":"WhatsApp Business App"}</td>
         <td className="py-2 pr-3">#{item.contact_id}</td>
         <td className="py-2 pr-3">{item.status}</td>
         <td className="py-2 pr-3">{item.updated_at?
           new Date(item.updated_at).toLocaleString("en-MY"): "—"}</td>
         <td className="py-2">{item.action}</td>
       </tr>)}</tbody>
     </table>
   </div>:null}
 </section>;
}
