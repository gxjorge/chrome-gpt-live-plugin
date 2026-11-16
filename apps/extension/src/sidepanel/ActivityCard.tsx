import { useEffect, useState } from "react";
import type { Activity } from "./activity";

export function ActivityCard({ activity }: { activity: Activity }) {
  const [now, setNow] = useState(Date.now());
  const busy = ["connecting", "thinking", "acting", "answering"].includes(activity.phase);
  useEffect(() => {
    if (!busy) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity.since, busy]);
  const seconds = Math.max(0, Math.floor((now - activity.since) / 1000));
  const slow = busy && seconds >= 8;

  return (
    <section className={`activity-card activity-card--${activity.phase}`} aria-label="Current activity">
      <div className="activity-card__heading">
        <span className="activity-card__phase">{activity.phase === "idle" ? "VOICE COMPANION" : activity.phase}</span>
        {busy && <span className="activity-card__time" aria-label={`${seconds} seconds elapsed`}>{seconds}s</span>}
      </div>
      <div className="activity-card__label" role="status">{activity.label}</div>
      {activity.phase === "confirming" && <p>Use Confirm or Decline below. Other actions will wait.</p>}
      {slow && <p role="status">
        {activity.phase === "acting"
          ? "Waiting for the page or tool. Avoid repeating the action; a timeout will be reported."
          : activity.phase === "connecting"
            ? "Waiting for the voice connection. No browser action has started."
            : "Astra is still working. You can keep speaking or deactivate to stop."}
      </p>}
    </section>
  );
}
