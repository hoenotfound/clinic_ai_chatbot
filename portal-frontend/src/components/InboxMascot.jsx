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

function useMedia(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

// Decode before switching poses. A short fade softens the change without
// keeping two visible characters on screen for any appreciable time.
export function MascotArtwork({ mode = "animated", pose = "idle", paused = false, sequence = 0 }) {
  const target = Object.hasOwn(ART, pose) ? pose : "idle";
  const [frame, setFrame] = useState({ shown: "idle", previous: null });
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const animate = mode === "animated" && !reduced && !paused;
  useEffect(() => {
    if (target === frame.shown) return;
    let cancelled = false;
    const image = new Image();
    image.onload = async () => {
      try { await image.decode(); } catch { /* Loaded image remains usable. */ }
      if (!cancelled) setFrame(old => ({ shown: target, previous: old.shown }));
    };
    image.onerror = () => { if (!cancelled) setFrame({ shown: "idle", previous: null }); };
    image.src = ART[target];
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [target, frame.shown]);
  useEffect(() => {
    if (!frame.previous) return;
    const timer = setTimeout(() => setFrame(old => ({ ...old, previous: null })), animate ? 160 : 0);
    return () => clearTimeout(timer);
  }, [frame.previous, frame.shown, animate]);
  return (
    <span className="da-mascot-stage" data-mode={mode} data-paused={paused}
      data-pose={frame.shown} aria-hidden="true">
      <span className="da-mascot-drift" key={frame.shown + ":" + sequence}>
        {animate && frame.previous && <img src={ART[frame.previous]} alt="" draggable="false"
          width="160" height="160" className="da-mascot-outgoing" />}
        <img src={ART[frame.shown]} alt="" draggable="false" width="160" height="160"
          className={"da-mascot-image" + (animate && frame.previous ? " da-mascot-entering" : "")}
          onError={event => { if (event.currentTarget.getAttribute("src") !== fallback) event.currentTarget.src = fallback; }} />
      </span>
    </span>
  );
}

export default function InboxMascot({ activity, selectedId, searching = false, busy = false,
  placement = "list", mobileThreadOpen = false }) {
  const [mode] = useMascotMode();
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const desktop = useMedia("(min-width: 1024px)");
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [ambient, setAmbient] = useState("idle");
  const [reaction, setReaction] = useState(null);
  const greeted = useRef(false);
  const seenSequence = useRef(activity?.sequence ?? 0);
  const active = placement === "thread" ? !desktop && mobileThreadOpen : desktop || !mobileThreadOpen;
  const canAnimate = active && mode === "animated" && visible && !reduced;
  const current = reaction && Number(reaction.contactId) === Number(selectedId) ? reaction : null;

  useEffect(() => {
    if (!active || mode === "hidden") return;
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [active, mode]);

  useEffect(() => {
    if (!canAnimate) return;
    for (const name of ACTIVE_POSES) { const image = new Image(); image.src = ART[name]; }
  }, [canAnimate]);

  useEffect(() => {
    if (!canAnimate || busy || searching || current) { setAmbient("idle"); return; }
    let timer;
    let roamingNow = false;
    let lastActivity = Date.now();
    const idleMs = 26000;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(check, Math.max(0, idleMs - (Date.now() - lastActivity)));
    }
    function check() {
      if (Date.now() - lastActivity < idleMs) { schedule(); return; }
      roamingNow = true;
      setAmbient("roaming");
      timer = setTimeout(() => {
        roamingNow = false;
        setAmbient("idle");
        lastActivity = Date.now();
        schedule();
      }, 2200);
    }
    function onActivity() {
      lastActivity = Date.now();
      if (roamingNow) {
        roamingNow = false;
        setAmbient("idle");
        schedule();
      }
    }
    const events = ["pointerdown", "pointermove", "keydown", "input", "wheel", "touchstart", "scroll"];
    for (const name of events) document.addEventListener(name, onActivity, { capture: true, passive: true });
    if (!greeted.current && placement === "list") {
      greeted.current = true;
      setAmbient("greeting");
      timer = setTimeout(() => { setAmbient("idle"); schedule(); }, 1800);
    } else { setAmbient("idle"); schedule(); }
    return () => {
      clearTimeout(timer);
      for (const name of events) document.removeEventListener(name, onActivity, true);
    };
  }, [canAnimate, busy, searching, current, selectedId, placement]);

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

  if (!active || mode === "hidden") return null;
  const pose = !canAnimate ? "idle"
    : current?.kind === "alert" || current?.kind === "success" ? current.kind
      : searching ? "searching" : current?.kind || ambient;
  return (
    <span className={"da-inbox-mascot-slot" + (placement === "thread" ? " da-inbox-mascot-thread" : "")}
      data-testid="inbox-mascot" aria-hidden="true">
      <MascotArtwork mode={canAnimate ? "animated" : "stationary"} pose={pose}
        paused={!visible} sequence={current?.sequence ?? 0} />
    </span>
  );
}
