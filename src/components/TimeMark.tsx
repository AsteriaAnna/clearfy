import type { ClarifyEvent } from "../api";
import { fmtDate, isoToLocalTime } from "../lib/time";

export function TimeMark({ ev }: { ev: ClarifyEvent }) {
  if (ev.due_start_at && ev.due_end_at) {
    return (
      <span className="time-mark range">
        <span>{isoToLocalTime(ev.due_start_at)}</span>
        <i />
        <span>{isoToLocalTime(ev.due_end_at)}</span>
      </span>
    );
  }
  if (ev.due_start_at) {
    return (
      <span className="time-mark point">
        <span>{isoToLocalTime(ev.due_start_at)}</span>
        <i />
      </span>
    );
  }
  if (ev.due_date) {
    return (
      <span className="time-mark point">
        <span>{fmtDate(ev.due_date).slice(0, 5)}</span>
        <i />
      </span>
    );
  }
  return <span className="time-mark no-time" />;
}

export function Circle({ onClick, accent, checked }: { onClick: () => void; accent?: boolean; checked?: boolean }) {
  return (
    <button
      className={`circle${accent ? " accent" : ""}${checked ? " checked" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label="完成"
    >
      {checked ? "✓" : ""}
    </button>
  );
}
