import { useEffect, useState } from "react";
import { DEFAULT_DASHY_POSITION, DASHY_SIZES, normalizeDashyPosition } from "../utils/dashyPosition";
const KEY = "da.inbox.dashy.placement.v1";
const CHANGE = "da:dashy-placement";
let fallback = null;
const initial = { position: DEFAULT_DASHY_POSITION, size: "auto" };
function normalize(value) {
  return { position: normalizeDashyPosition(value?.position),
    size: DASHY_SIZES.includes(value?.size) ? value.size : "auto" };
}
export function readDashyPlacement() {
  if (fallback) return fallback;
  try { return normalize(JSON.parse(localStorage.getItem(KEY) || "null")); }
  catch { return initial; }
}
export function updateDashyPlacement(patch) {
  const next = normalize({ ...readDashyPlacement(), ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(next)); fallback = null; }
  catch { fallback = next; }
  window.dispatchEvent(new Event(CHANGE));
}
export function useDashyPlacement() {
  const [value, setValue] = useState(readDashyPlacement);
  useEffect(() => {
    const refresh = () => setValue(readDashyPlacement());
    const storage = event => { if (event.key === KEY || event.key === null) { fallback = null; refresh(); } };
    window.addEventListener(CHANGE, refresh);
    window.addEventListener("storage", storage);
    refresh();
    return () => { window.removeEventListener(CHANGE, refresh); window.removeEventListener("storage", storage); };
  }, []);
  return [value, updateDashyPlacement];
}
