import { useEffect, useRef, useState } from "react";
import mascot from "../assets/da-mascot-inbox.webp";
import "./InboxMascot.css";

const PREFERENCE = "da.inbox.mascot.enabled.v1";
const PARTS = ["head", "left", "right", "rings", "spark"];

function readEnabled() {
  try { return localStorage.getItem(PREFERENCE) !== "false"; }
  catch { return true; }
}

// Entirely client-side. No new listeners on the server, polling or data access.
export default function InboxMascot({ activity }) {
  const [enabled, setEnabled] = useState(readEnabled);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [reaction, setReaction] = useState("idle");
  const seenSequence = useRef(activity?.sequence ?? 0);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const sequence = activity?.sequence ?? 0;
    const fresh = sequence !== seenSequence.current;
    seenSequence.current = sequence;
    if (!enabled || !visible || !fresh) {
      setReaction("idle");
      return;
    }
    setReaction(activity.kind === "alert" ? "alert" : "activity");
    const timer = setTimeout(() => setReaction("idle"), 1800);
    return () => clearTimeout(timer);
  }, [activity, enabled, visible]);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    try { localStorage.setItem(PREFERENCE, String(next)); }
    catch { /* Preference remains available for this Inbox session. */ }
  }

  return (
    <button type="button" className="da-inbox-mascot"
      aria-label="Show Inbox mascot" aria-pressed={enabled}
      title={enabled ? "Hide DA mascot" : "Show DA mascot"}
      data-testid="inbox-mascot-toggle" onClick={toggle}>
      {enabled ? (
        <span className="da-inbox-mascot-stage" data-paused={!visible}
          data-reaction={reaction} aria-hidden="true">
          <span className="da-inbox-mascot-hover">
            <span className="da-inbox-mascot-pose" key={activity?.sequence ?? 0}>
              {PARTS.map(part => (
                <img key={part} src={mascot} alt="" draggable="false"
                  className={"da-inbox-mascot-part da-inbox-mascot-" + part} />
              ))}
            </span>
          </span>
        </span>
      ) : <span className="da-inbox-mascot-off">Mascot off</span>}
    </button>
  );
}
