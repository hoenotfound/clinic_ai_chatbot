"use strict";

const { humanAgentChannelEnabled } = require("../utils/metaHumanAgent");
const { createInboxTreatmentResolver } = require("../utils/inboxTreatmentInterest");

const DEFAULT_FILTERS = Object.freeze({
  status:"all", channel:"all", sender:"all", control:"all",
  assignment:"all", replyWindow:"all", treatment:"all", query:"",
});
const statuses = new Set(["all","unreplied","follow-up","unread","attention","archived"]);
const channels = new Set(["all","whatsapp","facebook","instagram"]);
const controls = new Set(["all","ai","human"]);
const windows = new Set(["all","open","expired"]);
const UNSPECIFIED_TREATMENT = "__unspecified__";

function normalizeInboxPageFilters(input = {}) {
  const choose = (key,set) => set.has(input[key]) ? input[key] : "all";
  const sender = /^[a-z][a-z0-9_-]{0,63}$/.test(String(input.sender || ""))
    ? input.sender : "all";
  const assignment = /^(all|mine|unassigned|owner:[A-Za-z0-9_.@-]{1,80})$/.test(
    String(input.assignment || "")) ? input.assignment : "all";
  const treatment = String(input.treatment || "all").trim();
  return {
    status:choose("status",statuses), channel:choose("channel",channels),
    sender, control:choose("control",controls), assignment,
    replyWindow:choose("replyWindow",windows),
    treatment:treatment.length <= 160 && !/[\u0000-\u001f\u007f]/.test(treatment)
      ? treatment : "all",
    query:String(input.query || "").trim().slice(0,160),
  };
}

function openReplyWindow(row,now=Date.now()) {
  const channel=row.channel || "whatsapp";
  if (!["whatsapp","facebook","instagram"].includes(channel)) return false;
  const time=Date.parse(row.latest_inbound_at || "");
  if (!Number.isFinite(time)) return false;
  const days=channel!=="whatsapp" && humanAgentChannelEnabled(channel)?7:1;
  return now < time+days*24*3600*1000;
}

function matches(row,filters,{exclude=null,now=Date.now(),username="",canViewAll=true,resolveTreatment=createInboxTreatmentResolver()}={}) {
  const archived=Boolean(row.inbox_archived_at);
  if(exclude!=="status") {
    if(filters.status==="archived"){if(!archived)return false;}
    else {
      if(archived && !filters.query)return false;
      if(filters.status==="unreplied" && row.has_unreplied!==true)return false;
      if(filters.status==="follow-up" && !row.needs_follow_up)return false;
      if(filters.status==="unread" && !row.is_unread)return false;
      if(filters.status==="attention" && !row.needs_attention)return false;
    }
  }
  if(exclude!=="channel" && filters.channel!=="all" &&
      (row.channel||"whatsapp")!==filters.channel)return false;
  if(exclude!=="sender" && filters.sender!=="all" &&
      row.whatsapp_sender_key!==filters.sender)return false;
  if(exclude!=="control" && filters.control!=="all" && row.mode!==filters.control)return false;
  if(exclude!=="assignment" && canViewAll && filters.assignment!=="all"){
    const owner=row.lead_owner_username;
    if(filters.assignment==="mine" && (!username || owner!==username))return false;
    if(filters.assignment==="unassigned" && owner)return false;
    if(filters.assignment.startsWith("owner:") && owner!==filters.assignment.slice(6))return false;
  }
  if(exclude!=="replyWindow" && filters.replyWindow!=="all" &&
      openReplyWindow(row,now)!==(filters.replyWindow==="open"))return false;
  if(exclude!=="treatment" && filters.treatment!=="all") {
    const interest=resolveTreatment(row.treatment_interest).key;
    if(filters.treatment===UNSPECIFIED_TREATMENT ? Boolean(interest)
      : interest!==resolveTreatment(filters.treatment).key)return false;
  }
  if(exclude==="query" || !filters.query)return true;
  return row.search_match===true;
}

function inboxPageModel(rows,rawFilters,{
  offset=0,limit=100,now=Date.now(),username="",canViewAll=true,
}={}) {
  const filters=normalizeInboxPageFilters(rawFilters);
  const resolveTreatment=createInboxTreatmentResolver();
  const context={now,username,canViewAll,resolveTreatment};
  const matching=exclude=>rows.filter(row=>matches(row,filters,{...context,exclude}));
  const base=matching("status");
  const visibleBase=base.filter(row=>!row.inbox_archived_at||Boolean(filters.query));
  const replyBase=matching("replyWindow");
  const matchRows=matching(null);
  const statusCounts={
    all:visibleBase.length,
    unreplied:visibleBase.filter(row=>row.has_unreplied===true).length,
    "follow-up":visibleBase.filter(row=>row.needs_follow_up).length,
    unread:visibleBase.filter(row=>row.is_unread).length,
    archived:base.filter(row=>row.inbox_archived_at).length,
    attention:visibleBase.filter(row=>row.needs_attention).length,
  };
  const open=replyBase.filter(row=>openReplyWindow(row,now)).length;
  const senders=new Map(), owners=new Map(), treatments=new Map();
  let hasUnspecifiedTreatment=false;
  for(const row of rows) {
    const treatment=resolveTreatment(row.treatment_interest);
    if(!treatment.key)hasUnspecifiedTreatment=true;
    else if(treatment.key!=="all" && treatment.key!==UNSPECIFIED_TREATMENT &&
      !treatments.has(treatment.key)) {
      treatments.set(treatment.key,treatment.label);
    }
    if(row.channel==="whatsapp"&&row.whatsapp_sender_key) {
      const key=row.whatsapp_sender_key;
      senders.set(key,key==="neutro"?"DA":
        row.whatsapp_sender_display_name||key);
    }
    const owner=String(row.lead_owner_username||"").trim();
    if(owner&&owner!==username)owners.set(owner,
      String(row.lead_owner_display_name||owner).trim()||owner);
  }
  const senderOptions=[...senders.entries()].sort((a,b)=>a[1].localeCompare(b[1]));
  const treatmentOptions=[
    ["all","All treatments"],
    ...[...treatments.values()].sort((a,b)=>a.localeCompare(b))
      .map(label=>[label,label]),
    ...(hasUnspecifiedTreatment?[[UNSPECIFIED_TREATMENT,"Unspecified"]]:[]),
  ];
  const assignmentOptions=[
    ["all","All leads"],["mine","My leads"],["unassigned","Unassigned"],
    ...[...owners.entries()].sort((a,b)=>a[1].localeCompare(b[1]))
      .map(([owner,label])=>["owner:"+owner,label]),
  ];
  const start=Math.max(0,Math.min(100000,Number(offset)||0));
  const size=Math.max(1,Math.min(100,Number(limit)||100));
  const current=matchRows.slice(start,start+size);
  return {
    ids:current.map(row=>Number(row.contact_id)),
    total:matchRows.length, allCount:rows.length,
    nextOffset:start+current.length,
    hasMore:start+current.length<matchRows.length,
    statusCounts,replyWindowCounts:{open,expired:replyBase.length-open},
    senderOptions,assignmentOptions,treatmentOptions,
  };
}

module.exports={
  DEFAULT_FILTERS,normalizeInboxPageFilters,openReplyWindow,matches,inboxPageModel,
};
