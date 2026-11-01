import { useState } from "react";
import type { ClarifyEvent, NewEvent } from "../api";
import { updateEvent } from "../api";
import { isCount, isoToLocalDate, isoToLocalTime, todayISO } from "../lib/time";

export function DetailDrawer({
  event,
  onClose,
  onComplete,
  onDelete,
  onSaved,
}: {
  event: ClarifyEvent;
  onClose: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(event.title);
  const [dueDate, setDueDate] = useState(event.due_date || (event.due_start_at ? isoToLocalDate(event.due_start_at) : ""));
  const [start, setStart] = useState(event.due_start_at ? isoToLocalTime(event.due_start_at) : "");
  const [end, setEnd] = useState(event.due_end_at ? isoToLocalTime(event.due_end_at) : "");
  const [repeat, setRepeat] = useState(event.repeat_freq || "");
  const [countTarget, setCountTarget] = useState(event.count_target?.toString() || "");
  const [countPeriod, setCountPeriod] = useState<"day" | "week">((event.count_period as "day" | "week") || "day");

  async function save() {
    const isCountEvent = countTarget.trim() !== "";
    const payload: NewEvent = { title: title.trim() };
    if (isCountEvent) {
      payload.count_target = Number(countTarget);
      payload.count_period = countPeriod;
    } else {
      if (dueDate && !start) payload.due_date = dueDate;
      if (start) {
        const base = dueDate || todayISO();
        payload.due_start_at = new Date(`${base}T${start}:00`).toISOString();
        if (end) payload.due_end_at = new Date(`${base}T${end}:00`).toISOString();
      }
      if (repeat) {
        payload.repeat_freq = repeat as "day" | "week" | "month";
        payload.repeat_interval = 1;
      }
    }
    await updateEvent(event.id, payload);
    onSaved();
  }

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head"><b>详情</b><button className="icon-btn" onClick={onClose}>×</button></div>
        <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>日期<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        <div className="two">
          <label>开始<input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label>结束<input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        <label>重复
          <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
            <option value="">不重复</option>
            <option value="day">每天</option>
            <option value="week">每周</option>
            <option value="month">每月</option>
          </select>
        </label>
        <label>计数目标（如每天 3 杯）
          <div className="two">
            <input type="number" placeholder="次数" value={countTarget} onChange={(e) => setCountTarget(e.target.value)} />
            <select value={countPeriod} onChange={(e) => setCountPeriod(e.target.value as "day" | "week")}>
              <option value="day">每天</option>
              <option value="week">每周</option>
            </select>
          </div>
        </label>
        <div className="drawer-actions">
          <button className="primary" onClick={() => void save()}>保存</button>
          <button onClick={onComplete}>{isCount(event) ? "+1" : "完成"}</button>
          <button className="danger" onClick={onDelete}>删除</button>
        </div>
      </aside>
    </>
  );
}
