import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { ClarifyEvent, completeEvent, incrementCount, isTauri, listOpen } from "../api";

type Theme = "pink" | "sage" | "blue";
type Template = "a" | "b";
type Filter = "today" | "all";

const WIDTH = 300;
const HEIGHT_KEY = "clarify.overlay.height";
const TEMPLATE_KEY = "clarify.overlay.template";

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isoToLocalTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function eventDate(ev: ClarifyEvent): string | null {
  if (ev.due_date) return ev.due_date;
  if (ev.due_start_at) return isoToLocalDate(ev.due_start_at);
  return null;
}
function isCount(ev: ClarifyEvent) {
  return ev.count_target != null;
}

function TimeMark({ ev }: { ev: ClarifyEvent }) {
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
  return <span className="time-mark no-time" />;
}

function fmtShortDate(): string {
  const d = new Date();
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${wd}`;
}

export default function Overlay() {
  const [events, setEvents] = useState<ClarifyEvent[]>([]);
  const [template, setTemplate] = useState<Template>(() => (localStorage.getItem(TEMPLATE_KEY) as Template) || "a");
  const [filter, setFilter] = useState<Filter>("today");
  const [theme] = useState<Theme>(() => (localStorage.getItem("clarify.theme") as Theme) || "pink");
  const [height, setHeight] = useState<number>(() => Number(localStorage.getItem(HEIGHT_KEY)) || 220);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(TEMPLATE_KEY, template);
  }, [template]);

  // 恢复高度 + 跟随窗口尺寸变化
  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    void win.setSize(new LogicalSize(WIDTH, height));
    let unlisten: (() => void) | undefined;
    void win.onResized(({ payload }) => {
      const physical = payload.height;
      void win.scaleFactor().then((scale) => {
        const logical = Math.round(physical / scale);
        setHeight(logical);
        localStorage.setItem(HEIGHT_KEY, String(logical));
      });
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setEvents(await listOpen());
  }
  useEffect(() => {
    void load();
  }, []);

  async function onTaskClick(ev: ClarifyEvent) {
    if (isCount(ev)) await incrementCount(ev.id);
    else await completeEvent(ev.id);
    await load();
  }

  async function openMainToday() {
    if (isTauri) await invoke("open_main_today");
  }

  const today = todayISO();
  const todayEvents = useMemo(
    () =>
      events.filter((e) => {
        if (isCount(e)) return true;
        const d = eventDate(e);
        return !d || d === today;
      }),
    [events, today],
  );
  const timed = useMemo(
    () => todayEvents.filter((e) => e.due_start_at).sort((a, b) => (a.due_start_at || "").localeCompare(b.due_start_at || "")),
    [todayEvents],
  );

  const rowH = template === "a" ? 44 : 40;
  const chromeH = 46 + 40; // header + footer
  const capacity = Math.max(1, Math.floor((height - chromeH) / rowH));

  const list = template === "a" ? timed : filter === "today" ? todayEvents : events;
  const visible = list.slice(0, capacity);
  const hiddenCount = (template === "a" ? todayEvents.length : list.length) - visible.length;

  return (
    <div className="widget-shell">
      <div className="widget">
        <header className="w-head" data-tauri-drag-region>
          {template === "a" ? (
            <>
              <span className="eyebrow">今天</span>
              <span className="w-date">{fmtShortDate()}</span>
              <span className="w-progress">{timed.length}/{todayEvents.length}</span>
            </>
          ) : (
            <div className="w-toggle">
              <button className={filter === "today" ? "on" : ""} onClick={() => setFilter("today")}>今天</button>
              <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>全部</button>
            </div>
          )}
          <button className="home" title="打开 Clarify" onClick={() => void openMainToday()}>⌂</button>
          <button className="w-tpl" title="切换模板" onClick={() => setTemplate(template === "a" ? "b" : "a")}>
            {template === "a" ? "B" : "A"}
          </button>
        </header>

        <div className="w-body">
          {visible.length === 0 && <div className="w-empty">台面干净了。说一句？</div>}
          {visible.map((ev) => (
            <div className={`w-row${template === "b" ? " b" : ""}`} key={ev.id} onClick={() => void onTaskClick(ev)}>
              <button className="w-circle" onClick={(e) => { e.stopPropagation(); void onTaskClick(ev); }} />
              {template === "a" && <TimeMark ev={ev} />}
              <span className="w-title">{ev.title}</span>
              {isCount(ev) && <span className="w-chip">{ev.count_progress}/{ev.count_target}</span>}
              {template === "b" && !isCount(ev) && <TimeMark ev={ev} />}
            </div>
          ))}
        </div>

        <footer className="w-foot">
          <button className="w-add" onClick={() => void openMainToday()}>＋ 说一句</button>
          {hiddenCount > 0 && (
            <button className="w-more" onClick={() => void openMainToday()}>还有 {hiddenCount} 件 ›</button>
          )}
        </footer>

        <div
          className="w-resize"
          title="拖动调整高度"
          onMouseDown={() => {
            if (!isTauri) return;
            void getCurrentWindow().startResizeDragging("South" as never);
          }}
        />
      </div>
    </div>
  );
}
