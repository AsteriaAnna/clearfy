import { useEffect, useMemo, useRef, useState } from "react";
import {
  ClarifyEvent,
  aiParse,
  completeEvent,
  deleteEvent,
  incrementCount,
  isTauri,
  listCompleted,
  listOpen,
  restoreEvent,
  transcribeStream,
} from "./api";
import { Circle, TimeMark } from "./components/TimeMark";
import { DetailDrawer } from "./components/DetailDrawer";
import { Settings } from "./components/Settings";
import { bytesToBase64, startPcmRecorder, type PcmRecorder } from "./lib/audio";
import type { Theme } from "./lib/theme";
import {
  CN_WEEKDAYS,
  EN_MONTHS,
  EN_WEEKDAYS,
  WEEKDAYS,
  eventDate,
  fmtDate,
  isCount,
  isTimed,
  isoToLocalTime,
  pad,
  todayISO,
} from "./lib/time";

type Template = "a" | "b";
type Scale = "day" | "week" | "calendar";
type View = "today" | "all" | "settings";

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
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const captureRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const recordingRef = useRef(false);
  const toggleRecordingRef = useRef<() => void>(() => {});

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("clarify.theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("clarify.template", template);
  }, [template]);

  async function load() {
    try {
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
    let unOpen: (() => void) | undefined;
    let unCapture: (() => void) | undefined;
    let unVoice: (() => void) | undefined;
    let unChanged: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen("clarify://open-today", () => {
        setView("today");
        setSelected(null);
        if (template === "a") setScale("day");
        else setFilter("today");
      }).then((fn) => { unOpen = fn; });
      void listen("clarify://capture", () => {
        setView("today");
        setSelected(null);
        setTimeout(() => captureRef.current?.focus(), 80);
      }).then((fn) => { unCapture = fn; });
      void listen("clarify://voice", () => {
        setView("today");
        setSelected(null);
        toggleRecordingRef.current();
      }).then((fn) => { unVoice = fn; });
      void listen("clarify://changed", () => {
        void load();
      }).then((fn) => { unChanged = fn; });
    });
    return () => {
      unOpen?.();
      unCapture?.();
      unVoice?.();
      unChanged?.();
    };
  }, [template]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    toggleRecordingRef.current = () => {
      if (recordingRef.current) void stopRecording();
      else void startRecording();
    };
  });

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
    try {
      await restoreEvent(ev.id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }
  async function onDelete(ev: ClarifyEvent) {
    try {
      await deleteEvent(ev.id);
      setSelected(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }
  async function onCreate() {
    const title = draft.trim();
    if (!title) return;
    try {
      const outcome = await aiParse(title);
      setDraft("");
      const n = outcome.created.length;
      setToast(outcome.fallback ? `已创建 ${n} 项 · ${outcome.warning ?? "规则模式"}` : `AI 已安排 ${n} 项`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function startRecording() {
    try {
      recorderRef.current = await startPcmRecorder();
      setRecording(true);
    } catch (e) {
      setError(`无法使用麦克风：${String(e)}`);
    }
  }

  async function stopRecording() {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    setRecording(false);
    setTranscribing(true);
    try {
      const pcm = await rec.stop();
      if (pcm.length < 3200) {
        setError("太短了，再说一次？");
        return;
      }
      const text = await transcribeStream(bytesToBase64(pcm));
      const clean = text.trim();
      if (!clean) {
        setError("没听清，再说一次？");
        return;
      }
      const outcome = await aiParse(clean);
      setToast(`「${clean}」→ 已安排 ${outcome.created.length} 项`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  const today = todayISO();
  const open = useMemo(() => {
    if (filter === "all" || view === "all") return events;
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

  const hero = useMemo(() => {
    const d = new Date();
    return {
      en: `${EN_WEEKDAYS[d.getDay()]} · ${EN_MONTHS[d.getMonth()]} ${d.getDate()}`,
      big: `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`,
      sub: `${CN_WEEKDAYS[d.getDay()]} · 今天`,
    };
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
        <Settings
          theme={theme}
          setTheme={setTheme}
          onBack={() => setView("today")}
          onOpenTemplate={(t) => {
            setTemplate(t);
            setView("today");
            if (t === "a") setScale("day");
            else setFilter("today");
          }}
        />
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

          {template === "a" && scale === "day" && view === "today" && (
            <section className="hero">
              <div className="hero-main">
                <div className="hero-eyebrow">{hero.en}</div>
                <div className="hero-date"><span className="big">{hero.big}</span><span className="hero-sub">{hero.sub}</span></div>
              </div>
              <div className="hero-meta">{timed.length} 项时间 · {untimed.length} 项待安排</div>
            </section>
          )}

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
                  <button className="link" onClick={(e) => { e.stopPropagation(); void onRestore(ev); }}>恢复</button>
                </div>
              ))}
            </div>
          </main>

          <footer className="capture">
            <button
              className={`mic${recording ? " recording" : ""}`}
              title={recording ? "停止录音" : "语音"}
              disabled={transcribing}
              onClick={() => (recording ? void stopRecording() : void startRecording())}
            >
              {transcribing ? "…" : recording ? "■" : "🎙"}
            </button>
            <input
              ref={captureRef}
              value={draft}
              placeholder={transcribing ? "正在识别…" : recording ? "正在听…说完点一下 ■" : "说一句，或输入待办…（试试：明天下午三点开会）"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); }}
            />
            <button className="primary" onClick={() => void onCreate()}>创建</button>
          </footer>
        </>
      )}

      {error && <div className="error-toast" onClick={() => setError(null)}>{error}</div>}
      {toast && <div className="ok-toast" onClick={() => setToast(null)}>{toast} ✓</div>}
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
