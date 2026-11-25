import { useEffect, useRef, useState } from "react";
import mascot from "../assets/da-mascot-inbox.webp";
import { useMascotMode } from "../hooks/useMascotMode";
import "./InboxMascot.css";

// Keep approved expression artwork separate from motion; the neutral source
// remains the fallback until the owner's expression artwork is available.
export function MascotArtwork({ mode = "animated", reaction = "idle", paused = false, sequence = 0 }) {
  return (
    <span className="da-mascot-stage" data-mode={mode} data-paused={paused}
      data-reaction={reaction} aria-hidden="true">
      <span className="da-mascot-drift">
        <span className="da-mascot-pose" key={sequence}>
          <img src={mascot} alt="" draggable="false" className="da-mascot-part da-mascot-body" />
          <img src={mascot} alt="" draggable="false" className="da-mascot-part da-mascot-hand" />
          <img src={mascot} alt="" draggable="false" className="da-mascot-part da-mascot-rings" />
        </span>
      </span>
    </span>
  );
}
export default function InboxMascot({ activity }) {
  const [mode] = useMascotMode();
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
    if (mode !== "animated" || !visible || !fresh) {
      setReaction("idle");
      return;
    }
    setReaction(activity.kind === "alert" ? "alert" : "activity");
    const timer = setTimeout(() => setReaction("idle"), 1400);
    return () => clearTimeout(timer);
  }, [activity, mode, visible]);
  if (mode === "hidden") return null;
  return (
    <span className="da-inbox-mascot-slot" data-testid="inbox-mascot" aria-hidden="true">
      <MascotArtwork mode={mode} reaction={reaction} paused={!visible} sequence={activity?.sequence ?? 0} />
    </span>
  );
}
