const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("follow-up tools use a unified media picker and collapsible additional steps", () => {
  const source = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(source, /function FollowUpMediaPicker\(/);
  assert.match(source, /No media/);
  assert.match(source, /Follow-up 1 media/);
  assert.match(source, /Keep them collapsed when you are not editing them/);
  assert.match(source, /Preview Follow-up/);
  assert.match(source, /Toggle follow-up preview/);
  assert.match(source, /Sending rules/);
  assert.match(source, /order-2 min-w-0 xl:order-1/);
  assert.match(source, /follow-up-panel-sequence/);
  assert.match(source, /follow-up-panel-pricing/);
  assert.match(source, /follow-up-panel-whatsapp/);
  assert.match(source, /follow-up-panel-activity/);
  assert.match(source, /order-1 xl:order-2 xl:sticky/);
  assert.match(source, /xl:grid-cols-\[minmax\(0,1\.3fr\)_minmax\(19rem,0\.7fr\)\]/);
  assert.doesNotMatch(source, />Sequence<\/h2>/);
  assert.doesNotMatch(source, /function followUpMediaSummary/);
});

test("follow-up video preview stays private and validates stored keys", () => {
  const source = read("src/routes/config.js");

  assert.match(source, /router\.get\("\/automated-follow-up\/video-preview"/);
  assert.match(source, /!key \|\| !isFollowUpVideoKey\(key\)/);
  assert.match(source, /mediaStorage\.createPresignedGetUrl\(key/);
  assert.match(source, /expiresSeconds: 5 \* 60/);
  assert.match(source, /Cache-Control", "private, no-store"/);
  assert.match(source, /Referrer-Policy", "no-referrer"/);
  assert.match(source, /res\.redirect\(302, url\)/);
});

test("sender-specific follow-up controls are separated without mixing save actions", () => {
  const tools = read("portal-frontend/src/pages/Tools.jsx");
  const secondary = read("portal-frontend/src/components/ArielFollowUpRules.jsx");

  assert.match(tools, /aria-label="Follow-up sender"/);
  assert.match(tools, /Primary WhatsApp/);
  assert.match(tools, /Secondary WhatsApp/);
  assert.match(tools, /showStatusControl=\{false\}/);
  assert.match(tools, /ariaLabel="Enable 24-hour follow-ups"/);
  assert.match(tools, /hasUnsavedChanges=\{senderView === "primary" && hasUnsavedChanges\}/);
  assert.match(tools, /aria-label="Secondary follow-up sections"/);
  assert.match(tools, /aria-label="Follow-up activation overview"/);
  assert.match(tools, /View details and checks/);
  assert.match(tools, /Extended WhatsApp timeline/);
  assert.match(tools, /\["performance", "Results"\]/);
  assert.match(tools, /aria-label="Activity sections"/);
  assert.match(tools, /billingProtectionOpen, setBillingProtectionOpen\] = useState\(form\.whatsappFreeOnly\?\.enabled === true\)/);
  assert.match(tools, /activitySection === "recent"/);
  assert.match(tools, /activitySection === "health"/);
  assert.match(tools, /section=\{secondarySection\}/);
  assert.match(tools, /secondarySection === "media" && <ArielMediaReview \/>/);

  assert.match(secondary, /if\(!active\|\|config\)return/);
  assert.match(secondary, /section === "service"/);
  assert.match(secondary, /section === "marketing"/);
  assert.match(secondary, /<details key=\{slot\}/);
  assert.match(secondary, /Changes not saved/);
  assert.match(secondary, /setConfig\(prev=>prev\?/);
  assert.match(secondary, /operatorBillingApproved:row.enabled && row.approved===true/);
  assert.match(secondary, /readOnly aria-readonly="true"/);
  assert.match(secondary, /primaryFollowUpMessages/);
  assert.match(secondary, /Primary WhatsApp/);
  assert.doesNotMatch(secondary, /confirmClinicVideoReuse:true/);
});


test("secondary 48h/66h and Day 4/Day 6 template controls require per-language approval",()=>{
 const ui=read("portal-frontend/src/components/ArielFollowUpRules.jsx");
 const route=read("src/routes/whatsappSecondaryFollowUpRules.js");
 assert.match(ui,/MARKETING_SLOTS=\[48,66,96,144\]/);
 assert.doesNotMatch(ui,/\[48,72\]/);
 assert.match(ui,/ms/);
 assert.match(route,/\["zh_CN","en_US","ms"\]/);
 assert.match(ui,/approved treatment video is chosen automatically/);
 assert.match(route,/if\(!MARKETING_SLOTS\.has\(slot\)\)/);
 assert.match(route,/secondary_extended_template_mismatch/);
 assert.match(ui,/ns_day4_assessment_guide_v2/);
 assert.match(ui,/ns_day6_final_invite_v2/);
 assert.match(route,/extendedWorkerEnabled/);
 assert.doesNotMatch(route,/Only 48h and 72h/);
});


test("secondary follow-up status is based on effective ads-only worker and media gates",()=>{
 const route=read("src/routes/whatsappSecondaryFollowUpRules.js");
 assert.match(route,/enabled:serviceWorkerEnabled/);
 assert.match(route,/workerEnabled:serviceWorkerEnabled\(process\.env\)/);
 assert.match(route,/secondaryAdsOnlyFullAiMode\(process\.env\)/);
 assert.match(route,/WHATSAPP_SECONDARY_AI_MEDIA_ENABLED/);
});


test("secondary message preview is read-only and cannot overwrite inherited primary copy",()=>{
 const ui=read("portal-frontend/src/components/ArielFollowUpRules.jsx");
 const route=read("src/routes/whatsappSecondaryFollowUpRules.js");
 assert.match(ui,/value=\{inherited\} readOnly/);
 assert.match(ui,/saveSecondaryFollowUpRule\(slot,\{enabled:enabled\[slot\]\}\)/);
 assert.doesNotMatch(ui,/onChange=\{e=>setRules/);
 assert.doesNotMatch(ui,/messageText:rules\[slot\]/);
 assert.match(route,/const text=primaryFollowUpMessages\(configRepo\.getConfig\(\)\)\[slot\]/);
 assert.match(route,/primaryFollowUpMessages:primaryFollowUpMessages/);
});


test("secondary follow-up disable remains available even if primary content is temporarily missing",()=>{
 const ui=read("portal-frontend/src/components/ArielFollowUpRules.jsx");
 const route=read("src/routes/whatsappSecondaryFollowUpRules.js");
 assert.match(ui,/enabled\[slot\]&&inherited\.length<3/);
 assert.match(route,/if\(!enabled\)\{/);
 assert.match(route,/UPDATE whatsapp_sender_followup_rules SET enabled=FALSE/);
 assert.match(route,/text=primaryFollowUpMessages\(configRepo\.getConfig\(\)\)\[slot\]/);
});
