import { useEffect, useRef, useState } from "react";
import idle from "../assets/dashy/idle.webp?no-inline";
import greeting from "../assets/dashy/greeting.webp?no-inline";
import roaming from "../assets/dashy/roaming.webp?no-inline";
import searching from "../assets/dashy/searching.webp?no-inline";
import thinking from "../assets/dashy/thinking.webp?no-inline";
import success from "../assets/dashy/success.webp?no-inline";
import alert from "../assets/dashy/alert.webp?no-inline";
import welcome from "../assets/dashy/welcome.webp?no-inline";
import blocked from "../assets/dashy/blocked.webp?no-inline";
import confident from "../assets/dashy/confident.webp?no-inline";
import fallback from "../assets/da-mascot-inbox.webp";
import { useMascotMode } from "../hooks/useMascotMode";
import "./InboxMascot.css";

const ART = { idle, greeting, roaming, searching, thinking, success, alert, welcome, blocked, confident };
const ACTIVE_POSES = ["idle", "greeting", "roaming", "searching", "success", "alert"];
export const DASHY_POSES = [
  ["idle", "Idle"], ["greeting", "Greeting"], ["roaming", "Roaming"],
  ["searching", "Searching / Finding"], ["thinking", "Thinking"],
  ["success", "Success"], ["alert", "Alert"],
  ["welcome", "Welcome"], ["blocked", "Crossed hands"], ["confident", "Confident"],
];

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

// Each supplied pose is complete artwork, not arbitrary cutouts of a face.
// Keep the last loaded pose while a different asset loads to avoid flashing.
export function MascotArtwork({ mode = "animated", pose = "idle", paused = false, sequence = 0 }) {
  const target = Object.hasOwn(ART, pose) ? pose : "idle";
  const [shown, setShown] = useState("idle");
  useEffect(() => {
    if (target === shown) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setShown(target); };
    image.onerror = () => { if (!cancelled) setShown("idle"); };
    image.src = ART[target];
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [target, shown]);
  return (
    <span className="da-mascot-stage" data-mode={mode} data-paused={paused}
      data-pose={shown} aria-hidden="true">
      <span className="da-mascot-drift" key={shown + ":" + sequence}>
        <img src={ART[shown]} alt="" draggable="false" width="160" height="160"
          className="da-mascot-image"
          onError={event => { if (event.currentTarget.getAttribute("src") !== fallback) event.currentTarget.src = fallback; }} />
      </span>
    </span>
  );
}

export default function InboxMascot({ activity, selectedId, searching = false }) {
  const [mode] = useMascotMode();
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [ambient, setAmbient] = useState("idle");
  const [reaction, setReaction] = useState(null);
  const greeted = useRef(false);
  const seenSequence = useRef(0);
  const canAnimate = mode === "animated" && visible && !reduced;

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!canAnimate) return;
    // Static assets only; browser caches them. No polling or new API calls.
    for (const name of ACTIVE_POSES) {
      const image = new Image();
      image.src = ART[name];
    }
  }, [canAnimate]);

  useEffect(() => {
    if (!canAnimate) { setAmbient("idle"); return; }
    let timer;
    function rest() {
      setAmbient("idle");
      timer = setTimeout(() => {
        setAmbient("roaming");
        timer = setTimeout(rest, 2200);
      }, 26000);
    }
    if (!greeted.current) {
      setAmbient("greeting");
      timer = setTimeout(() => { greeted.current = true; rest(); }, 1800);
    } else rest();
    return () => clearTimeout(timer);
  }, [canAnimate]);

  useEffect(() => {
    const sequence = activity?.sequence ?? 0;
    const fresh = sequence !== seenSequence.current;
    seenSequence.current = sequence;
    if (!canAnimate || !fresh || selectedId == null || Number(activity?.contactId) !== Number(selectedId) ||
        activity.until <= Date.now()) {
      setReaction(null);
      return;
    }
    setReaction(activity);
    const timer = setTimeout(() => setReaction(null), Math.max(0, activity.until - Date.now()));
    return () => clearTimeout(timer);
  }, [activity, canAnimate, selectedId]);

  if (mode === "hidden") return null;
  const current = reaction && Number(reaction.contactId) === Number(selectedId) ? reaction : null;
  const pose = !canAnimate ? "idle"
    : current?.kind === "alert" || current?.kind === "success" ? current.kind
      : searching ? "searching" : current?.kind || ambient;
  return (
    <span className="da-inbox-mascot-slot" data-testid="inbox-mascot" aria-hidden="true">
      <MascotArtwork mode={canAnimate ? "animated" : "stationary"} pose={pose}
        paused={!visible} sequence={current?.sequence ?? 0} />
    </span>
  );
}
