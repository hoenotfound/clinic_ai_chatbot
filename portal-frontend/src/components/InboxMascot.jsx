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
const SCROLL_AREAS = ".wa-thread-messages, .wa-inbox-rows";
const THREAD_ACTIONS = "button, a, summary, audio[controls], video[controls], [role=button], img.cursor-zoom-in, input, select, textarea";
const LIST_ACTIONS = "button:not(.wa-inbox-row), a[href], [role=button]:not(.wa-inbox-row)";
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
      const obstacles = [];
      function addRect(node, clip = box) {
        if (!node.getClientRects().length) return;
        const r = node.getBoundingClientRect();
        const rect = { left: Math.max(r.left, clip.left, box.left) - box.left,
          right: Math.min(r.right, clip.right, box.right) - box.left,
          top: Math.max(r.top, clip.top, box.top) - box.top,
          bottom: Math.min(r.bottom, clip.bottom, box.bottom) - box.top };
        if (rect.right > rect.left && rect.bottom > rect.top) obstacles.push(rect);
      }
      for (const node of nodes) if (node.matches(PROTECTED)) addRect(node);
      // Protect actual message controls as well as headers. Clip to the
      // scroll container so offscreen messages do not reserve workspace.
      for (const panel of nodes.filter(node => node.matches(SCROLL_AREAS))) {
        if (!panel.getClientRects().length) continue;
        const clip = panel.getBoundingClientRect();
        const selector = panel.matches(".wa-thread-messages") ? THREAD_ACTIONS : LIST_ACTIONS;
        for (const control of panel.querySelectorAll(selector)) addRect(control, clip);
      }
      const viewport = window.visualViewport;
      const area = dashyVisibleArea({ left: box.left, top: box.top, width: host.clientWidth, height: host.clientHeight },
        viewport || { offsetLeft: 0, offsetTop: 0, width: window.innerWidth, height: window.innerHeight });
      const next = { ...area, obstacles };
      setSpace(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    }
    function schedule(event) {
      if (event?.target instanceof Element && event.target.closest(".da-mascot-layer")) return;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    }
    const observer = new ResizeObserver(schedule);
    function syncNodes() {
      observer.disconnect();
      nodes = Array.from(host.querySelectorAll(PROTECTED + ", " + SCROLL_AREAS));
      observer.observe(host);
      for (const node of nodes) observer.observe(node);
      measure();
    }
    syncNodes();
    // Layout changes can replace the composer/header; observe only structure
    // and avoid observing the mascot's own animated attributes.
    const mutation = new MutationObserver(records => {
      const relevant = records.filter(record => record.target instanceof Element && !record.target.closest(".da-mascot-layer"));
      if (relevant.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(PROTECTED + ", " + SCROLL_AREAS) || node.querySelector(PROTECTED + ", " + SCROLL_AREAS))))) {
        syncNodes();
      } else if (relevant.some(record => record.target.closest(SCROLL_AREAS))) schedule();
    });
    mutation.observe(host, { childList: true, subtree: true });
    host.addEventListener("scroll", schedule, { capture: true, passive: true });
    host.addEventListener("load", schedule, true);
    host.addEventListener("transitionend", schedule, true);
    window.addEventListener("resize", schedule);
    observedViewport?.addEventListener("resize", schedule);
    observedViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect();
      host.removeEventListener("scroll", schedule, true);
      host.removeEventListener("load", schedule, true);
      host.removeEventListener("transitionend", schedule, true);
      window.removeEventListener("resize", schedule);
      observedViewport?.removeEventListener("resize", schedule);
      observedViewport?.removeEventListener("scroll", schedule);
    };
  }, [hostRef, layoutKey, enabled]);
  return space;
}

function DashyIcon({ name }) {
  const paths = {
    close: "M6 6l12 12M18 6L6 18",
    pause: "M9 5v14M15 5v14",
    play: "M8 5l11 7-11 7z",
    expand: "M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4",
    reset: "M4 11a8 8 0 1 1 2 6M4 5v6h6",
    minimize: "M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5",
    hide: "M3 3l18 18M10.5 10.5a2 2 0 0 0 3 3M9 5a11 11 0 0 1 3-.5c6 0 10 7.5 10 7.5a16 16 0 0 1-3.5 4M6 6.5A17 17 0 0 0 2 12s4 7.5 10 7.5a10 10 0 0 0 4-.9",
  };
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export default function InboxMascot({ hostRef, activity, selectedId, searching: searchLoading = false, busy = false,
  suspended = false, layoutKey, mobileThreadOpen = false }) {
  const [mode, setMode] = useMascotMode();
  const [placement, updatePlacement] = useDashyPlacement();
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const desktop = useMedia("(min-width: 1024px)");
  const canRoam = useMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine)");
  const searching = searchLoading && (desktop || !mobileThreadOpen);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [ambient, setAmbient] = useState("idle");
  const [reaction, setReaction] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const motionRef = useRef(null);
  const releasePoint = useRef(null);
  const restoreFocus = useRef(false);
  const [reading, setReading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [hint, setHint] = useState(false);
  const hintSeen = useRef(hasSeenHint());
  const dragFrame = useRef(0);
  const ignoreClick = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [typing, setTyping] = useState(false);
  const [hoverGreeting, setHoverGreeting] = useState(false);
  const [focused, setFocused] = useState(false);
  const drag = useRef(null);
  const controlRef = useRef(null);
  const menuRef = useRef(null);
  const greeted = useRef(false);
  const seenSequence = useRef(activity?.sequence ?? 0);
  const space = useWorkspace(hostRef, layoutKey, mode !== "hidden");
  const size = Math.min(minimized ? 44 : dashySize(space.width, placement.size), Math.max(0, space.height - 24), Math.max(0, space.width - 24));
  const bounds = offsetDashyBounds(space, size);
  const point = safeDashyPoint(dashyPoint(minimized ? { x: .99, y: placement.position.y } : placement.position, bounds), bounds, size, space.obstacles);
  const renderable = mode !== "hidden" && !suspended && size >= 44 && !!point;
  const canAnimate = renderable && !minimized && mode === "animated" && visible && !reduced;
  const current = reaction && Number(reaction.contactId) === Number(selectedId) ? reaction : null;
  const motionBlocked = busy || typing || reading || dragging || menuOpen;
  const quiet = motionBlocked || editing || focused || hovered;
  const menuPosition = point && !minimized && (dashyMenuPosition(point, size, space, space.obstacles, 248, 326) ||
    dashyMenuPosition(point, size, space, space.obstacles, 176, 220, 64));
  const hintPosition = point && dashyMenuPosition(point, size, space, space.obstacles, 156, 38, 38);
  const flight = dashyFlight(point, bounds, size, space.obstacles);
  const roamingNow = canAnimate && !quiet && !searching && !current && canRoam && ambient === "roaming" && (flight.x !== 0 || flight.y !== 0);

  useEffect(() => {
    if (mode === "hidden") return;
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [mode]);

  useEffect(() => {
    if (!renderable) {
      motionRef.current?.cancel(); motionRef.current = null;
      setMenuOpen(false); setDragging(false); drag.current = null; setFocused(false); setHovered(false); setHoverGreeting(false); setTyping(false);
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

  // Actual typing pauses the artwork briefly. Merely leaving a field focused
  // does not stop idle hovering for the rest of a staff session.
  useEffect(() => {
    if (!renderable) return;
    const host = hostRef.current;
    let timer;
    function onTyping(event) {
      if (!(event.target instanceof Element) || event.target.closest(".da-mascot-layer") ||
          !event.target.closest("input, textarea, [contenteditable=true]")) return;
      setTyping(true);
      clearTimeout(timer);
      timer = setTimeout(() => setTyping(false), 2500);
    }
    for (const name of ["input", "keydown", "compositionstart", "compositionupdate", "compositionend"])
      host?.addEventListener(name, onTyping, true);
    return () => {
      clearTimeout(timer);
      for (const name of ["input", "keydown", "compositionstart", "compositionupdate", "compositionend"])
        host?.removeEventListener(name, onTyping, true);
    };
  }, [renderable, hostRef]);

  // Greet the pointer once, then return to the idle loop even if it stays.
  useEffect(() => {
    if (!hoverGreeting) return;
    const timer = setTimeout(() => setHoverGreeting(false), 1500);
    return () => clearTimeout(timer);
  }, [hoverGreeting]);

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
    if (!renderable || minimized || !visible || !hintPosition || hintSeen.current || busy || editing) return;
    hintSeen.current = true;
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* optional */ }
    setHint(true);
  }, [renderable, minimized, visible, Boolean(hintPosition), busy, editing]);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), 5500);
    return () => clearTimeout(timer);
  }, [hint]);
  useEffect(() => () => { cancelAnimationFrame(dragFrame.current); motionRef.current?.cancel(); }, []);
  useLayoutEffect(() => {
    if (!dragging) {
      controlRef.current?.style.removeProperty("--dashy-drag-x");
      controlRef.current?.style.removeProperty("--dashy-drag-y");
    }
  }, [dragging]);
  // The flight and the release animation share one transform. Read the
  // current transform before cancelling so interruptions do not snap.
  useLayoutEffect(() => {
    const el = controlRef.current;
    const previous = motionRef.current;
    const from = previous && el ? getComputedStyle(el).transform : "none";
    previous?.cancel();
    motionRef.current = null;
    if (!el || !renderable || minimized || dragging || reduced || !visible) {
      releasePoint.current = null;
      return;
    }
    if (roamingNow && typeof el.animate === "function") {
      const t = (x, y) => `translate3d(${x}px, ${y}px, 0)`;
      motionRef.current = el.animate([
        { transform: t(0, 0), offset: 0 },
        { transform: t(flight.x * .45, flight.y * .1), offset: .25 },
        { transform: t(flight.x, flight.y), offset: .55 },
        { transform: t(flight.x * .25, flight.y * .8), offset: .8 },
        { transform: t(0, 0), offset: 1 },
      ], { duration: 2200, easing: "ease-in-out" });
      return;
    }
    const release = releasePoint.current;
    releasePoint.current = null;
    const initial = release ? `translate3d(${release.x - point.x}px, ${release.y - point.y}px, 0)` : from;
    if (initial !== "none" && typeof el.animate === "function") {
      motionRef.current = el.animate([{ transform: initial }, { transform: "translate3d(0,0,0)" }],
        { duration: 180, easing: "cubic-bezier(.2,.75,.35,1)" });
    }
  }, [roamingNow, dragging, reduced, visible, renderable, minimized, point?.x, point?.y, flight.x, flight.y, size]);

  useLayoutEffect(() => {
    if (restoreFocus.current && renderable) {
      restoreFocus.current = false;
      controlRef.current?.focus({ preventScroll: true });
    }
  }, [minimized, renderable]);
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
    const idleMs = 60000;
    function schedule() {
      clearTimeout(timer);
      if (canRoam) timer = setTimeout(check, Math.max(0, idleMs - (Date.now() - lastActivity)));
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
  }, [canAnimate, quiet, searching, current, selectedId, canRoam]);

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
    if (minimized || event.button !== 0 || !event.isPrimary || drag.current || !point) return;
    const host = hostRef.current?.getBoundingClientRect();
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = host ? clampDashyPoint({ x: rect.left - host.left, y: rect.top - host.top }, bounds) : point;
    motionRef.current?.cancel(); motionRef.current = null;
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
    if (!cancelled && d.moved && d.latest) {
      releasePoint.current = d.latest;
      savePoint(d.latest);
    }
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function toggleMinimized() {
    setHint(false);
    setMenuOpen(false);
    setHovered(false);
    restoreFocus.current = document.activeElement === controlRef.current || menuRef.current?.contains(document.activeElement);
    setMinimized(old => !old);
  }
  function openControls() {
    setHint(false);
    if (minimized) { toggleMinimized(); return; }
    if (menuPosition) setMenuOpen(old => !old);
    else toggleMinimized(); // Remain in the Inbox even when the keyboard leaves no room.
  }
  function closeControls() {
    setMenuOpen(false);
    controlRef.current?.focus();
  }
  function key(event) {
    if (event.key === "Enter" || event.key === " ") ignoreClick.current = false;
    setHint(false);
    if (minimized) return;
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
      : searching ? "searching" : current?.kind || (hoverGreeting && !menuOpen && !motionBlocked ? "greeting" : quiet ? "idle" : ambient);
  // The gentle artwork loop is independent of the larger flight timer.
  // Focus and hover alone restrict roaming, not ordinary hovering.
  const animate = canAnimate && !motionBlocked && (pose === "idle" || !quiet || (hoverGreeting && pose === "greeting" && !editing));
  const dimmed = !dragging && !hovered && !focused && !menuOpen && (reading || editing || busy) && !current && !searching;
  return (
    <div className="da-mascot-layer" aria-label="Dashy floating companion">
      <button type="button" ref={controlRef} className="da-mascot-control" data-testid="inbox-mascot"
        data-dragging={dragging} data-roaming={roamingNow} data-dimmed={dimmed} data-minimized={minimized}
        aria-label={minimized ? "Restore Dashy" : "Dashy companion. Drag to move, use arrow keys, or open controls"}
        aria-expanded={minimized ? undefined : menuOpen} title={minimized ? "Restore Dashy" : "Drag Dashy or click for controls"}
        style={{ left: point.x, top: point.y, width: size, height: size, "--dashy-flight-x": flight.x + "px", "--dashy-flight-y": flight.y + "px" }}
        onPointerDown={start} onPointerMove={move} onPointerUp={event => end(event)}
        onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)}
        onKeyDown={key} onClick={() => { if (ignoreClick.current) { ignoreClick.current = false; return; } openControls(); }}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onPointerEnter={event => { if (event.pointerType === "mouse") { setHovered(true); setHoverGreeting(true); } }}
        onPointerLeave={() => { setHovered(false); setHoverGreeting(false); }}>
        <MascotArtwork mode={animate ? "animated" : "stationary"} pose={pose}
          paused={!visible} sequence={current?.sequence ?? 0} />
        <span className="da-mascot-hit" aria-hidden="true" />
        {minimized && <span className="da-mascot-restore" aria-hidden="true"><DashyIcon name="expand" /></span>}
      </button>
      {hint && !minimized && hintPosition && !quiet && !menuOpen && visible && <span className="da-mascot-hint" aria-hidden="true" style={hintPosition}>Drag me · tap for controls</span>}
      {menuOpen && menuPosition && (
        <div ref={menuRef} className="da-mascot-menu" role="group" aria-label="Dashy controls" style={menuPosition}>
          <div className="da-mascot-menu-title"><span>Dashy<small>Your Inbox companion</small></span><button type="button" aria-label="Close Dashy controls" onClick={closeControls}><DashyIcon name="close" /></button></div>
          <button type="button" onClick={() => { setMode(mode === "animated" ? "stationary" : "animated"); closeControls(); }}><DashyIcon name={mode === "animated" ? "pause" : "play"} />{mode === "animated" ? "Pause animation" : "Resume animation"}</button>
          <fieldset className="da-mascot-size">
            <legend><DashyIcon name="expand" /> Size</legend>
            <div className="da-mascot-size-options">
              {[["auto","Auto"],["small","S"],["medium","M"],["large","L"]].map(([value,label]) => (
                <label key={value} className={placement.size === value ? "is-selected" : ""}>
                  <input type="radio" name="dashy-quick-size" aria-label={"Dashy size " + value} checked={placement.size === value} onChange={() => updatePlacement({ size: value })} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" onClick={() => { updatePlacement({ position: DEFAULT_DASHY_POSITION }); closeControls(); }}><DashyIcon name="reset" />Reset position</button>
          <button type="button" onClick={toggleMinimized}><DashyIcon name="minimize" />Minimise temporarily</button>
          <div className="da-mascot-menu-separator" />
          <button type="button" onClick={() => { setMode("hidden"); setMenuOpen(false); }}><DashyIcon name="hide" />Hide Dashy</button>
          <p>Restore hidden Dashy in Settings → Appearance.</p>
        </div>
      )}
    </div>
  );
}
