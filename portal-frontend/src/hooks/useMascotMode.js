import { useEffect, useState } from "react";
const KEY = "da.inbox.mascot.mode.v2";
const LEGACY = "da.inbox.mascot.enabled.v1";
const CHANGE = "da:mascot-mode";
const MODES = ["animated", "stationary", "hidden"];
let fallback = null;
export function readMascotMode() {
  if (fallback) return fallback;
  try {
    const value = localStorage.getItem(KEY);
    if (MODES.includes(value)) return value;
    if (localStorage.getItem(LEGACY) === "false") return "hidden";
  } catch { /* storage may be disabled */ }
  return "animated";
}
export function setMascotMode(mode) {
  if (!MODES.includes(mode)) return;
  try { localStorage.setItem(KEY, mode); fallback = null; }
  catch { fallback = mode; }
  window.dispatchEvent(new Event(CHANGE));
}
export function useMascotMode() {
  const [mode, update] = useState(readMascotMode);
  useEffect(() => {
    const refresh = () => update(readMascotMode());
    const onStorage = event => {
      if (event.key === KEY || event.key === LEGACY || event.key === null) {
        fallback = null;
        refresh();
      }
    };
    window.addEventListener(CHANGE, refresh);
    window.addEventListener("storage", onStorage);
    refresh();
    return () => {
      window.removeEventListener(CHANGE, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [mode, setMascotMode];
}
