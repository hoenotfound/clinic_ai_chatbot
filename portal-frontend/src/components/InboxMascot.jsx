import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { DEFAULT_DASHY_POSITION, dashySize, dashyVisibleArea, offsetDashyBounds, dashyPoint, dashyFraction, clampDashyPoint, safeDashyPoint, dashyMenuPosition, dashyFlight } from "../utils/dashyPosition";
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
const EMPTY = { left: 0, top: 0, width: 0, height: 0, obstacles: [] };
const HINT_KEY = "da.inbox.dashy.hint.v1";
function hasSeenHint() { try { return localStorage.getItem(HINT_KEY) === "1"; } catch { return false; } }
function useWorkspace(hostRef, layoutKey, enabled) {
  const [space, setSpace] = useState(EMPTY);
  // A child layout effect can run before the parent host ref is attached.
  // The passive effect runs after attachment, including an empty Inbox.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) return;
    const observedViewport = window.visualViewport;
    let frame = 0;
    let nodes = [];
    function measure() {
      const box = host.getBoundingClientRect();
      const obstacles = nodes.filter(node => node.getClientRects().length).map(node => {
        const r = node.getBoundingClientRect();
        return { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top };
      }).filter(r => r.right > r.left && r.bottom > r.top);
      const viewport = window.visualViewport;
      const area = dashyVisibleArea({ left: box.left, top: box.top, width: host.clientWidth, height: host.clientHeight },
        viewport || { offsetLeft: 0, offsetTop: 0, width: window.innerWidth, height: window.innerHeight });
      const next = { ...area, obstacles };
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
    observedViewport?.addEventListener("resize", schedule);
    observedViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect();
      window.removeEventListener("resize", schedule);
      observedViewport?.removeEventListener("resize", schedule);
      observedViewport?.removeEventListener("scroll", schedule);
    };
  }, [hostRef, layoutKey, enabled]);
  return space;
}

export default function InboxMascot({ hostRef, activity, selectedId, searching: searchLoading = false, busy = false,
  suspended = false, layoutKey, mobileThreadOpen = false }) {
  const navigate = useNavigate();
  const [mode, setMode] = useMascotMode();
  const [placement, updatePlacement] = useDashyPlacement();
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const desktop = useMedia("(min-width: 1024px)");
  const searching = searchLoading && (desktop || !mobileThreadOpen);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [ambient, setAmbient] = useState("idle");
  const [reaction, setReaction] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [hint, setHint] = useState(false);
  const hintSeen = useRef(hasSeenHint());
  const dragFrame = useRef(0);
  const ignoreClick = useRef(false);
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
  const bounds = offsetDashyBounds(space, size);
  const point = safeDashyPoint(dashyPoint(placement.position, bounds), bounds, size, space.obstacles);
  const renderable = mode !== "hidden" && !suspended && size >= 44 && !!point;
  const canAnimate = renderable && mode === "animated" && visible && !reduced;
  const current = reaction && Number(reaction.contactId) === Number(selectedId) ? reaction : null;
  const quiet = busy || editing || reading || dragging || menuOpen || focused || hovered;
  const menuPosition = point && dashyMenuPosition(point, size, space, space.obstacles);
  const hintPosition = point && dashyMenuPosition(point, size, space, space.obstacles, 156, 38, 38);
  const flight = dashyFlight(point, bounds, size, space.obstacles);

  useEffect(() => {
    if (mode === "hidden") return;
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [mode]);

  useEffect(() => {
    if (!renderable) {
      setMenuOpen(false); setDragging(false); drag.current = null; setFocused(false); setHovered(false);
      cancelAnimationFrame(dragFrame.current); dragFrame.current = 0;
    }
  }, [renderable]);

  useEffect(() => {
    if (!renderable) return;
    const isEditing = el => Boolean(el instanceof Element && el.matches("input, textarea, select, [contenteditable=true]") && hostRef.current?.contains(el));
    const focusIn = event => setEditing(isEditing(event.target));
    const focusOut = event => setEditing(isEditing(event.relatedTarget));
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    setEditing(isEditing(document.activeElement));
    return () => { document.removeEventListener("focusin", focusIn); document.removeEventListener("focusout", focusOut); };
  }, [renderable, hostRef]);

  useEffect(() => {
    if (!renderable) { setReading(false); return; }
    const host = hostRef.current;
    let timer;
    function onRead(event) {
      if (!(event.target instanceof Element) || event.target.closest(".da-mascot-layer")) return;
      if (!event.target.closest(".wa-thread-messages, .wa-inbox-list")) return;
      setReading(true);
      clearTimeout(timer);
      timer = setTimeout(() => setReading(false), 3500);
    }
    for (const name of ["scroll", "wheel", "pointerdown", "touchstart"]) host?.addEventListener(name, onRead, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const name of ["scroll", "wheel", "pointerdown", "touchstart"]) host?.removeEventListener(name, onRead, true);
    };
  }, [renderable, hostRef]);

  useEffect(() => {
    if (!renderable || !visible || !hintPosition || hintSeen.current || busy || editing) return;
    hintSeen.current = true;
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* optional */ }
    setHint(true);
  }, [renderable, visible, Boolean(hintPosition), busy, editing]);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), 5500);
    return () => clearTimeout(timer);
  }, [hint]);
  useEffect(() => () => cancelAnimationFrame(dragFrame.current), []);
  useLayoutEffect(() => {
    if (!dragging) {
      controlRef.current?.style.removeProperty("--dashy-drag-x");
      controlRef.current?.style.removeProperty("--dashy-drag-y");
    }
  }, [dragging]);
  // A viewport/layout change invalidates the pointer origin; cancel cleanly.
  useLayoutEffect(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    ignoreClick.current = true;
    cancelAnimationFrame(dragFrame.current); dragFrame.current = 0;
    setDragging(false);
    const el = controlRef.current;
    if (el?.hasPointerCapture(d.id)) el.releasePointerCapture(d.id);
  }, [space, size, layoutKey]);
  useEffect(() => {
    if (menuOpen && !menuPosition) setMenuOpen(false);
  }, [menuOpen, Boolean(menuPosition)]);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector("button")?.focus();
  }, [menuOpen]);

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
  function paintDrag(p, base = point) {
    const el = controlRef.current;
    if (!el || !base) return;
    el.style.setProperty("--dashy-drag-x", (p.x - base.x) + "px");
    el.style.setProperty("--dashy-drag-y", (p.y - base.y) + "px");
  }
  function start(event) {
    if (event.button !== 0 || !event.isPrimary || drag.current || !point) return;
    const host = hostRef.current?.getBoundingClientRect();
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = host ? clampDashyPoint({ x: rect.left - host.left, y: rect.top - host.top }, bounds) : point;
    event.currentTarget.setPointerCapture(event.pointerId);
    ignoreClick.current = false;
    drag.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, point: origin, base: point, moved: false };
    setHint(false);
    paintDrag(origin);
    setDragging(true);
  }
  function move(event) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.clientX, dy = event.clientY - d.clientY;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) { d.moved = true; setMenuOpen(false); }
    d.latest = clampDashyPoint({ x: d.point.x + dx, y: d.point.y + dy }, bounds);
    if (!dragFrame.current) dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      if (drag.current === d && d.latest) paintDrag(d.latest, d.base);
    });
  }
  function end(event, cancelled = false) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(dragFrame.current); dragFrame.current = 0;
    ignoreClick.current = cancelled || d.moved;
    if (!cancelled && d.moved && d.latest) savePoint(d.latest);
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function openControls() {
    setHint(false);
    if (menuPosition) setMenuOpen(old => !old);
    else navigate("/settings/appearance");
  }
  function closeControls() {
    setMenuOpen(false);
    controlRef.current?.focus();
  }
  function key(event) {
    if (event.key === "Enter" || event.key === " ") ignoreClick.current = false;
    setHint(false);
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (direction) {
      event.preventDefault(); setMenuOpen(false);
      const step = event.shiftKey ? 40 : 12;
      savePoint({ x: point.x + direction[0] * step, y: point.y + direction[1] * step });
    }
  }

  if (!renderable) return null;
  const pose = !canAnimate || dragging ? "idle"
    : current?.kind === "alert" || current?.kind === "success" ? current.kind
      : searching ? "searching" : current?.kind || (hovered && !menuOpen ? "greeting" : quiet ? "idle" : ambient);
  const animate = canAnimate && !quiet && (desktop || pose !== "idle");
  const roamingNow = animate && pose === "roaming" && (flight.x !== 0 || flight.y !== 0);
  const dimmed = !dragging && !hovered && !focused && !menuOpen && (reading || editing || busy) && !current && !searching;
  return (
    <div className="da-mascot-layer" aria-label="Dashy floating companion">
      <button type="button" ref={controlRef} className="da-mascot-control" data-testid="inbox-mascot"
        data-dragging={dragging} data-roaming={roamingNow} data-dimmed={dimmed}
        aria-label="Dashy companion. Drag to move, use arrow keys, or open controls"
        aria-expanded={menuOpen} title="Drag Dashy or click for controls"
        style={{ left: point.x, top: point.y, width: size, height: size, "--dashy-flight-x": flight.x + "px", "--dashy-flight-y": flight.y + "px" }}
        onPointerDown={start} onPointerMove={move} onPointerUp={event => end(event)}
        onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)}
        onKeyDown={key} onClick={() => { if (ignoreClick.current) { ignoreClick.current = false; return; } openControls(); }}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }}
        onPointerLeave={() => setHovered(false)}>
        <MascotArtwork mode={animate ? "animated" : "stationary"} pose={pose}
          paused={!visible} sequence={current?.sequence ?? 0} />
        <span className="da-mascot-hit" aria-hidden="true" />
      </button>
      {hint && hintPosition && !quiet && !menuOpen && visible && <span className="da-mascot-hint" aria-hidden="true" style={hintPosition}>Drag me · tap for controls</span>}
      {menuOpen && menuPosition && (
        <div ref={menuRef} className="da-mascot-menu" role="group" aria-label="Dashy controls" style={menuPosition}>
          <div className="da-mascot-menu-title">Dashy <button type="button" aria-label="Close Dashy controls" onClick={() => { setMenuOpen(false); controlRef.current?.focus(); }}>×</button></div>
          <button type="button" onClick={() => { setMode(mode === "animated" ? "stationary" : "animated"); closeControls(); }}>{mode === "animated" ? "Pause animation" : "Resume animation"}</button>
          <label>Size <select aria-label="Dashy size" value={placement.size} onChange={event => updatePlacement({ size: event.target.value })}>
            <option value="auto">Automatic</option><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
          </select></label>
          <button type="button" onClick={() => { updatePlacement({ position: DEFAULT_DASHY_POSITION }); closeControls(); }}>Reset position</button>
          <button type="button" onClick={() => { setMode("hidden"); setMenuOpen(false); }}>Hide Dashy</button>
          <p>Restore in Settings → Appearance.</p>
        </div>
      )}
    </div>
  );
}
