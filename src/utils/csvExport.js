const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;
const TIME_ZONE = "Asia/Kuala_Lumpur";

function safeSpreadsheetValue(value) {
  if (value == null) return "";
  const text = String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = safeSpreadsheetValue(value).replace(/"/g, '""');
  return `"${text}"`;
}

// Excel and Sheets can coerce long numeric identifiers into floating-point
// numbers and silently lose digits. For system identifiers that are strictly
// numeric, emit a harmless text formula so the displayed value remains exact.
// Any non-numeric value falls back to the normal injection-safe CSV path.
function identifierCsvCell(value) {
  if (value == null || value === "") return csvCell("");
  const text = String(value);
  if (/^\d+$/.test(text)) {
    return `"=""${text}"""`;
  }
  return csvCell(text);
}

function malaysiaDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} +08:00`;
}

function channelLabel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return "WhatsApp";
}

function sourceValue(row) {
  return row.lead_source || row.attribution_source || "";
}

function campaignValue(row) {
  return row.lead_campaign_name || row.attribution_campaign_name || "";
}

function platformCustomerId(row) {
  return row.social_account_id || row.whatsapp_number || "";
}

function sourceOverrideValue(row) {
  if (!row.attribution_source || !row.lead_source) return "";
  return row.lead_source !== row.attribution_source ? row.lead_source : "";
}

function campaignOverrideValue(row) {
  if (!row.attribution_source || !row.lead_campaign_name) return "";
  return row.lead_campaign_name !== row.attribution_campaign_name
    ? row.lead_campaign_name
    : "";
}

const CUSTOMER_COLUMNS = [
  ["Customer Name", (row) => row.customer_name],
  ["Channel", (row) => channelLabel(row.channel)],
  ["Platform Customer ID", platformCustomerId, identifierCsvCell],
  ["WhatsApp Number", (row) => row.whatsapp_number, identifierCsvCell],
  ["Lead Stage", (row) => row.stage_name],
  ["Service Interest", (row) => row.treatment_interest],
  ["Owner", (row) => row.owner_display_name || row.owner_username],
  ["Lead Source", sourceValue],
  ["Campaign", campaignValue],
  ["Last Contact", (row) => malaysiaDateTime(row.last_message_at)],
  ["Message Count", (row) => row.message_count ?? 0],
  ["Customer Since", (row) => malaysiaDateTime(row.customer_created_at)],
];

const FULL_COLUMNS = [
  ...CUSTOMER_COLUMNS,
  ["Lead Temperature", (row) => row.temperature],
  ["Branch", (row) => row.branch_name],
  ["Estimated Value (RM)", (row) => row.estimated_value],
  ["Appointment Status", (row) => row.appointment_status],
  ["Appointment At", (row) => malaysiaDateTime(row.appointment_at)],
  ["Next Follow-up", (row) => malaysiaDateTime(row.next_follow_up_at)],
  ["Lost Reason", (row) => row.lost_reason],
  ["CRM Marketing Consent", (row) => row.marketing_consent],
  ["WhatsApp Opt-in At", (row) => malaysiaDateTime(row.whatsapp_opt_in_at)],
  ["WhatsApp Opt-in Source", (row) => row.whatsapp_opt_in_source],
  ["WhatsApp Opt-out At", (row) => malaysiaDateTime(row.whatsapp_opt_out_at)],
  ["WhatsApp Opt-out Source", (row) => row.whatsapp_opt_out_source],
  ["WhatsApp Marketing Opt-out At", (row) => malaysiaDateTime(row.whatsapp_marketing_opt_out_at)],
  ["WhatsApp Marketing Opt-out Source", (row) => row.whatsapp_marketing_opt_out_source],
  ["Captured Acquisition Source", (row) => row.attribution_source],
  ["Source Override", sourceOverrideValue],
  ["Captured Platform", (row) => row.attribution_platform],
  ["Captured Campaign", (row) => row.attribution_campaign_name],
  ["Campaign Override", campaignOverrideValue],
  ["Campaign ID", (row) => row.campaign_id, identifierCsvCell],
  ["Ad Set ID", (row) => row.adset_id, identifierCsvCell],
  ["Ad Set Name", (row) => row.adset_name],
  ["Ad ID", (row) => row.meta_ad_id, identifierCsvCell],
  ["Ad Name", (row) => row.ad_name],
  ["First-touch Attributed At", (row) => malaysiaDateTime(row.attributed_at)],
  ["Lead Created At", (row) => malaysiaDateTime(row.lead_created_at)],
];

function columnsForPreset(preset) {
  return preset === "full" ? FULL_COLUMNS : CUSTOMER_COLUMNS;
}

function buildCustomerCsv(rows, preset = "customer") {
  const columns = columnsForPreset(preset);
  const header = columns.map(([label]) => csvCell(label)).join(",");
  const body = (rows || []).map((row) =>
    columns.map(([, read, encode = csvCell]) => encode(read(row))).join(",")
  );
  return `\uFEFF${[header, ...body].join("\r\n")}`;
}

function malaysiaDateStamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "export";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

module.exports = {
  buildCustomerCsv,
  channelLabel,
  csvCell,
  identifierCsvCell,
  malaysiaDateStamp,
  malaysiaDateTime,
  safeSpreadsheetValue,
};
