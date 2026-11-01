import { useEffect, useMemo, useState } from "react";
import {
  ClarifyEvent,
  NewEvent,
  createEvent,
  completeEvent,
  deleteEvent,
  incrementCount,
  isTauri,
  listCompleted,
  listOpen,
  restoreEvent,
  todayISO,
  updateEvent,
} from "./api";

type Theme = "pink" | "sage" | "blue";
type Template = "a" | "b";
type Scale = "day" | "week" | "calendar";
type View = "today" | "all" | "settings";

const THEMES: { id: Theme; label: string }[] = [
  { id: "pink", label: "雾粉" },
  { id: "sage", label: "鼠尾草" },
  { id: "blue", label: "雾蓝石墨" },
];

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

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
function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${pad(m)}.${pad(d)} ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()]}`;
}
function eventDate(ev: ClarifyEvent): string | null {
  if (ev.due_date) return ev.due_date;
  if (ev.due_start_at) return isoToLocalDate(ev.due_start_at);
  return null;
}
function isCount(ev: ClarifyEvent) {
  return ev.count_target != null;
}
function isTimed(ev: ClarifyEvent) {
  return !!ev.due_start_at;
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
  if (ev.due_date) {
    return <span className="time-mark point"><span>{fmtDate(ev.due_date).slice(0, 5)}</span><i /></span>;
  }
  return <span className="time-mark no-time" />;
}

function Circle({ onClick, accent }: { onClick: () => void; accent?: boolean }) {
  return <button className={`circle${accent ? " accent" : ""}`} onClick={onClick} aria-label="完成" />;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("clarify.theme") as Theme) || "pink");
  const [template, setTemplate] = useState<Template>(() => (localStorage.getItem("clarify.template") as Template) || "a");
  const [scale, setScale] = useState<Scale>("day");
  const [view, setView] = useState<View>("today");
  const [filter, setFilter] = useState<"today" | "all">("today");
  const [events, setEvents] = useState<ClarifyEvent[]>([]);
  const [completed, setCompleted] = useState<ClarifyEvent[]>([]);
  const [selected, setSelected] = useState<ClarifyEvent | null>(null);
  const [draft, setDraft] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("clarify.theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("clarify.template", template);
  }, [template]);

  async function load() {
    try {
      setLoading(true);
      const [open, done] = await Promise.all([listOpen(), listCompleted()]);
      setEvents(open);
      setCompleted(done);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("clarify://open-today", () => {
        setView("today");
        setSelected(null);
        if (template === "a") setScale("day");
        else setFilter("today");
      }).then((fn) => { unlisten = fn; }),
    );
    return () => unlisten?.();
  }, [template]);

  async function onComplete(ev: ClarifyEvent) {
    try {
      if (isCount(ev)) await incrementCount(ev.id);
      else await completeEvent(ev.id);
      if (selected?.id === ev.id) setSelected(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }
  async function onRestore(ev: ClarifyEvent) {
    await restoreEvent(ev.id);
    await load();
  }
  async function onDelete(ev: ClarifyEvent) {
    await deleteEvent(ev.id);
    setSelected(null);
    await load();
  }
  async function onCreate() {
    const title = draft.trim();
    if (!title) return;
    await createEvent({ title });
    setDraft("");
    await load();
  }

  const today = todayISO();
  const open = useMemo(() => {    if (filter === "all" || view === "all") return events;
    return events.filter((e) => {
      if (isCount(e)) return true;
      const d = eventDate(e);
      return !d || d <= today;
    });
  }, [events, filter, view, today]);

  const timed = useMemo(
    () => open.filter((e) => isTimed(e) && eventDate(e) === today).sort((a, b) => (a.due_start_at || "").localeCompare(b.due_start_at || "")),
    [open, today],
  );
  const untimed = useMemo(() => open.filter((e) => !isTimed(e)), [open]);

  const weekDays = useMemo(() => {
    const now = new Date();
    const day = (now.getDay() + 6) % 7;
    const start = new Date(now);
    start.setDate(now.getDate() - day);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });
  }, []);

  const monthDays = useMemo(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const cells: (string | null)[] = Array(offset).fill(null);
    for (let d = 1; d <= days; d++) cells.push(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`);
    return cells;
  }, []);

  return (
    <div className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand"><span className="orb" />Clarify</div>
        <div className="title-date">{fmtDate(today)} · 今天</div>
        <div className="title-actions">
          <div className="tabs" data-tauri-drag-region="false">
            <button className={template === "a" ? "on" : ""} onClick={() => setTemplate("a")}>A 时间轴</button>
            <button className={template === "b" ? "on" : ""} onClick={() => setTemplate("b")}>B 清单</button>
          </div>
          <button className="icon-btn" title="设置" onClick={() => setView(view === "settings" ? "today" : "settings")}>⚙</button>
          {isTauri && (
            <div className="window-btns">
              <button onClick={() => import("@tauri-apps/api/window").then((m) => m.getCurrentWindow().minimize())}>–</button>
              <button onClick={() => import("@tauri-apps/api/window").then((m) => m.getCurrentWindow().close())}>×</button>
            </div>
          )}
        </div>
      </header>

      {view === "settings" ? (
        <Settings theme={theme} setTheme={setTheme} onBack={() => setView("today")} />
      ) : (
        <>
          <div className="viewbar">
            <div className="seg">
              <button className={view === "today" ? "on" : ""} onClick={() => setView("today")}>今天</button>
              <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>全部</button>
            </div>
            {template === "a" ? (
              <div className="seg small">
                <button className={scale === "day" ? "on" : ""} onClick={() => setScale("day")}>一天</button>
                <button className={scale === "week" ? "on" : ""} onClick={() => setScale("week")}>7天</button>
                <button className={scale === "calendar" ? "on" : ""} onClick={() => setScale("calendar")}>日历</button>
              </div>
            ) : (
              <div className="seg small">
                <button className={filter === "today" ? "on" : ""} onClick={() => setFilter("today")}>今天</button>
                <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>全部</button>
              </div>
            )}
          </div>

          <main className="content">
            {loading ? <div className="empty">正在打开 Clarify…</div> : null}

            {template === "a" && scale === "day" && !loading && (
              <section className="timeline">
                {timed.map((ev) => (
                  <div className="row" key={ev.id} onClick={() => setSelected(ev)}>
                    <TimeMark ev={ev} />
                    <Circle accent={ev.id === timed[0]?.id} onClick={() => onComplete(ev)} />
                    <span className="row-title">{ev.title}</span>
                    {isCount(ev) && <span className="chip">{ev.count_progress}/{ev.count_target}</span>}
                  </div>
                ))}
                {untimed.length > 0 && (
                  <>
                    <div className="section-label">无时间 / 计数</div>
                    {untimed.map((ev) => (
                      <div className="row" key={ev.id} onClick={() => setSelected(ev)}>
                        <TimeMark ev={ev} />
                        <Circle onClick={() => onComplete(ev)} />
                        <span className="row-title">{ev.title}</span>
                        {isCount(ev) && <span className="chip">{ev.count_progress}/{ev.count_target}</span>}
                      </div>
                    ))}
                  </>
                )}
                {timed.length === 0 && untimed.length === 0 && <div className="empty">今天清空了。说一句？</div>}
              </section>
            )}

            {template === "a" && scale === "week" && !loading && (
              <section className="week">
                {weekDays.map((d, i) => (
                  <div className="week-col" key={d}>
                    <div className="week-head"><b>{WEEKDAYS[i]}</b><span>{d.slice(5)}</span></div>
                    {events.filter((e) => eventDate(e) === d).map((ev) => (
                      <div className="week-item" key={ev.id} onClick={() => setSelected(ev)}>
                        {isTimed(ev) && <em>{isoToLocalTime(ev.due_start_at!)}</em>}
                        <span>{ev.title}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            )}

            {template === "a" && scale === "calendar" && !loading && (
              <section className="calendar">
                {WEEKDAYS.map((w) => <div className="cal-head" key={w}>{w}</div>)}
                {monthDays.map((d, i) => (
                  <div className={`cal-cell${d === today ? " today" : ""}`} key={i}>
                    {d && <span className="cal-day">{Number(d.slice(8))}</span>}
                    {d && events.filter((e) => eventDate(e) === d).slice(0, 3).map((ev) => (
                      <div className="cal-item" key={ev.id} onClick={() => setSelected(ev)}>{ev.title}</div>
                    ))}
                  </div>
                ))}
              </section>
            )}

            {template === "b" && !loading && (
              <section className="list">
                {open.map((ev) => (
                  <div className="row" key={ev.id} onClick={() => setSelected(ev)}>
                    <Circle accent={ev.id === open[0]?.id} onClick={() => onComplete(ev)} />
                    <span className="row-title">{ev.title}</span>
                    {isCount(ev) ? <span className="chip">{ev.count_progress}/{ev.count_target}</span> : <TimeMark ev={ev} />}
                  </div>
                ))}
                {open.length === 0 && <div className="empty">台面干净了。说一句？</div>}
              </section>
            )}

            <div className="completed-fold">
              <button onClick={() => setShowCompleted((v) => !v)}>
                已完成 {completed.length} {showCompleted ? "收起" : "展开"}
              </button>
              {showCompleted && completed.map((ev) => (
                <div className="row done" key={ev.id}>
                  <span className="circle checked">✓</span>
                  <span className="row-title">{ev.title}</span>
                  <button className="link" onClick={() => onRestore(ev)}>恢复</button>
                </div>
              ))}
            </div>
          </main>

          <footer className="capture">
            <button className="mic" title="语音（M2 接入）">🎙</button>
            <input
              value={draft}
              placeholder="说一句，或输入待办…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); }}
            />
            <button className="primary" onClick={() => void onCreate()}>创建</button>
          </footer>
        </>
      )}

      {error && <div className="error-toast" onClick={() => setError(null)}>{error}</div>}
      {selected && (
        <DetailDrawer
          event={selected}
          onClose={() => setSelected(null)}
          onComplete={() => onComplete(selected)}
          onDelete={() => onDelete(selected)}
          onSaved={async () => { setSelected(null); await load(); }}
        />
      )}
    </div>
  );
}

function Settings({ theme, setTheme, onBack }: { theme: Theme; setTheme: (t: Theme) => void; onBack: () => void }) {
  return (
    <main className="content settings">
      <div className="back" onClick={onBack}>← 返回</div>
      <h2>外观主题</h2>
      <div className="theme-cards">
        {THEMES.map((t) => (
          <button key={t.id} className={`theme-card theme-${t.id}${theme === t.id ? " on" : ""}`} onClick={() => setTheme(t.id)}>
            <span className="swatch" /><b>{t.label}</b>
          </button>
        ))}
      </div>
      <h2>关于</h2>
      <p className="muted">Clarify · 本地运行 · 无账号 · 数据只在本机</p>
      <p className="muted">M2 开发版：AI 语音与官方解析将在下一阶段接入。</p>
    </main>
  );
}

function DetailDrawer({
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
      payload.count_period = countPeriod as "day" | "week";
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
