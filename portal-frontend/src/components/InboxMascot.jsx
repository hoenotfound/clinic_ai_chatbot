import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { useDashyPlacement } from "../hooks/useDashyPlacement";
import { DEFAULT_DASHY_POSITION, dashySize, dashyBounds, dashyPoint, dashyFraction, clampDashyPoint, safeDashyPoint } from "../utils/dashyPosition";
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

const PROTECTED = ".wa-inbox-list-header, .wa-thread-header, .wa-thread-composer";
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "input", "wheel", "touchstart", "scroll"];
const EMPTY = { width: 0, height: 0, obstacles: [] };
function useWorkspace(hostRef, layoutKey, enabled) {
  const [space, setSpace] = useState(EMPTY);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) return;
    let frame = 0;
    let nodes = [];
    function measure() {
      const box = host.getBoundingClientRect();
      const obstacles = nodes.filter(node => node.getClientRects().length).map(node => {
        const r = node.getBoundingClientRect();
        return { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top };
      }).filter(r => r.right > r.left && r.bottom > r.top);
      const next = { width: host.clientWidth, height: host.clientHeight, obstacles };
      setSpace(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); }
    const observer = new ResizeObserver(schedule);
    function syncNodes() {
      observer.disconnect();
      nodes = Array.from(host.querySelectorAll(PROTECTED));
      observer.observe(host);
      for (const node of nodes) observer.observe(node);
      measure();
    }
    syncNodes();
    // Layout changes can replace the composer/header; observe only structure
    // and avoid observing the mascot's own animated attributes.
    const mutation = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(PROTECTED) || node.querySelector(PROTECTED))))) syncNodes();
    });
    mutation.observe(host, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [hostRef, layoutKey, enabled]);
  return space;
}

export default function InboxMascot({ hostRef, activity, selectedId, searching: searchLoading = false, busy = false,
  suspended = false, layoutKey, mobileThreadOpen = false }) {
  const [mode, setMode] = useMascotMode();
  const [placement, updatePlacement] = useDashyPlacement();
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const desktop = useMedia("(min-width: 1024px)");
  const searching = searchLoading && (desktop || !mobileThreadOpen);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [ambient, setAmbient] = useState("idle");
  const [reaction, setReaction] = useState(null);
  const [dragPoint, setDragPoint] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState(false);
  const drag = useRef(null);
  const controlRef = useRef(null);
  const menuRef = useRef(null);
  const greeted = useRef(false);
  const seenSequence = useRef(activity?.sequence ?? 0);
  const space = useWorkspace(hostRef, layoutKey, mode !== "hidden");
  const size = Math.min(dashySize(space.width, placement.size), Math.max(0, space.height - 24));
  const bounds = dashyBounds(space.width, space.height, size);
  const rest = safeDashyPoint(dashyPoint(placement.position, bounds), bounds, size, space.obstacles);
  const point = dragPoint ? clampDashyPoint(dragPoint, bounds) : rest;
  const renderable = mode !== "hidden" && !suspended && size >= 44 && !!point;
  const canAnimate = renderable && mode === "animated" && visible && !reduced;
  const current = reaction && Number(reaction.contactId) === Number(selectedId) ? reaction : null;
  const quiet = busy || editing || !!dragPoint || menuOpen || focused;

  useEffect(() => {
    if (mode === "hidden") return;
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [mode]);

  useEffect(() => {
    if (!renderable) { setMenuOpen(false); setDragPoint(null); drag.current = null; setFocused(false); }
  }, [renderable]);

  useEffect(() => {
    if (!renderable) return;
    const update = () => {
      const el = document.activeElement;
      setEditing(Boolean(el?.matches("input, textarea, select, [contenteditable=true]") && hostRef.current?.contains(el)));
    };
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    update();
    return () => { document.removeEventListener("focusin", update); document.removeEventListener("focusout", update); };
  }, [renderable, hostRef]);

  useEffect(() => {
    if (!menuOpen) return;
    const outside = event => {
      if (!controlRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const escape = event => { if (event.key === "Escape") { setMenuOpen(false); controlRef.current?.focus(); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!canAnimate) return;
    for (const name of ACTIVE_POSES) { const image = new Image(); image.src = ART[name]; }
  }, [canAnimate]);

  useEffect(() => {
    if (!canAnimate || quiet || searching || current) { setAmbient("idle"); return; }
    let timer, roamingNow = false, lastActivity = Date.now();
    const idleMs = 75000;
    function schedule() {
      clearTimeout(timer);
      if (desktop) timer = setTimeout(check, Math.max(0, idleMs - (Date.now() - lastActivity)));
    }
    function check() {
      if (Date.now() - lastActivity < idleMs) { schedule(); return; }
      roamingNow = true;
      setAmbient("roaming");
      timer = setTimeout(() => { roamingNow = false; setAmbient("idle"); lastActivity = Date.now(); schedule(); }, 2200);
    }
    function onActivity() {
      lastActivity = Date.now();
      if (roamingNow) { roamingNow = false; setAmbient("idle"); schedule(); }
    }
    for (const name of ACTIVITY_EVENTS) document.addEventListener(name, onActivity, { capture: true, passive: true });
    if (!greeted.current) {
      greeted.current = true; setAmbient("greeting");
      timer = setTimeout(() => { setAmbient("idle"); schedule(); }, 1800);
    } else { setAmbient("idle"); schedule(); }
    return () => {
      clearTimeout(timer);
      for (const name of ACTIVITY_EVENTS) document.removeEventListener(name, onActivity, true);
    };
  }, [canAnimate, quiet, searching, current, selectedId, desktop]);

  useEffect(() => {
    const sequence = activity?.sequence ?? 0;
    const fresh = sequence !== seenSequence.current;
    seenSequence.current = sequence;
    if (!canAnimate || !fresh || selectedId == null || Number(activity?.contactId) !== Number(selectedId) ||
        activity.until <= Date.now()) { setReaction(null); return; }
    setReaction(activity);
    const timer = setTimeout(() => setReaction(null), Math.max(0, activity.until - Date.now()));
    return () => clearTimeout(timer);
  }, [activity, canAnimate, selectedId]);

  function savePoint(p) {
    const safe = safeDashyPoint(p, bounds, size, space.obstacles);
    if (safe) updatePlacement({ position: dashyFraction(safe, bounds) });
  }
  function start(event) {
    if (event.button !== 0 || !event.isPrimary || drag.current || !point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, point, moved: false };
  }
  function move(event) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.clientX, dy = event.clientY - d.clientY;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true; setMenuOpen(false);
    d.latest = clampDashyPoint({ x: d.point.x + dx, y: d.point.y + dy }, bounds);
    setDragPoint(d.latest);
  }
  function end(event, cancelled = false) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!cancelled && d.moved && d.latest) savePoint(d.latest);
    if (!cancelled && !d.moved) setMenuOpen(old => !old);
    setDragPoint(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function key(event) {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (direction) {
      event.preventDefault(); setMenuOpen(false);
      const step = event.shiftKey ? 40 : 12;
      savePoint({ x: point.x + direction[0] * step, y: point.y + direction[1] * step });
    }
  }

  if (!renderable) return null;
  const pose = !canAnimate || dragPoint ? "idle"
    : current?.kind === "alert" || current?.kind === "success" ? current.kind
      : searching ? "searching" : current?.kind || (quiet ? "idle" : ambient);
  const animate = canAnimate && !quiet && (desktop || pose !== "idle");
  const menuWidth = Math.min(224, space.width - 24);
  const menuX = Math.max(12, Math.min(space.width - menuWidth - 12, point.x + size / 2 - menuWidth / 2));
  // Menus use the same viewport bounds; overflow scrolls on a small screen.
  const above = point.y > space.height - point.y - size;
  const availableMenuHeight = Math.max(0, above ? point.y - 20 : space.height - point.y - size - 20);
  return (
    <div className="da-mascot-layer" aria-label="Dashy floating companion">
      <button type="button" ref={controlRef} className="da-mascot-control" data-testid="inbox-mascot"
        data-dragging={Boolean(dragPoint)} aria-label="Dashy companion. Drag to move, use arrow keys, or open controls"
        aria-expanded={menuOpen} title="Drag Dashy or click for controls"
        style={{ left: point.x, top: point.y, width: size, height: size }}
        onPointerDown={start} onPointerMove={move} onPointerUp={event => end(event)}
        onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)}
        onKeyDown={key} onClick={event => { if (event.detail === 0) setMenuOpen(old => !old); }}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
        <MascotArtwork mode={animate ? "animated" : "stationary"} pose={pose}
          paused={!visible} sequence={current?.sequence ?? 0} />
      </button>
      {menuOpen && (
        <div ref={menuRef} className="da-mascot-menu" aria-label="Dashy controls"
          style={{ left: menuX, width: menuWidth, maxHeight: availableMenuHeight,
            ...(above ? { bottom: space.height - point.y + 6 } : { top: point.y + size + 6 }) }}>
          <div className="da-mascot-menu-title">Dashy <button type="button" aria-label="Close Dashy controls" onClick={() => { setMenuOpen(false); controlRef.current?.focus(); }}>×</button></div>
          <button type="button" onClick={() => { setMode(mode === "animated" ? "stationary" : "animated"); setMenuOpen(false); }}>{mode === "animated" ? "Pause animation" : "Resume animation"}</button>
          <label>Size <select aria-label="Dashy size" value={placement.size} onChange={event => updatePlacement({ size: event.target.value })}>
            <option value="auto">Automatic</option><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
          </select></label>
          <button type="button" onClick={() => { updatePlacement({ position: DEFAULT_DASHY_POSITION }); setMenuOpen(false); }}>Reset position</button>
          <button type="button" onClick={() => { setMode("hidden"); setMenuOpen(false); }}>Hide Dashy</button>
          <p>Restore in Settings → Appearance.</p>
        </div>
      )}
    </div>
  );
}
