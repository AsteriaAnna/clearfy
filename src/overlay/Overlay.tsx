import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { aiParse, completeEvent, incrementCount, isTauri, listOpen, transcribeStream, type ClarifyEvent } from "../api";
import { bytesToBase64, startPcmRecorder, type PcmRecorder } from "../lib/audio";
import { eventDate, fmtShortDate, isCount, isoToLocalTime, todayISO } from "../lib/time";

type Theme = "pink" | "sage" | "blue";
type Template = "a" | "b";
type Filter = "today" | "all";

const COLLAPSED_KEY = "clarify.overlay.collapsed";
const HEIGHT_KEY = "clarify.overlay.height";
const TEMPLATE_KEY = "clarify.overlay.template";
const COLLAPSED_SIZE = 64;
const EXPANDED_WIDTH = 300;
const DEFAULT_HEIGHT = 260;

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="3.5" width="6" height="10" rx="3" />
      <path d="M6 11.5a6 6 0 0 0 12 0" />
      <path d="M12 17.5V21" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4.5L20 8.5a2.12 2.12 0 0 0-3-3L5.5 17 4 20Z" />
      <path d="M13.5 6.5 17.5 10.5" />
    </svg>
  );
}

function OverlayTimeMark({ ev, isToday }: { ev: ClarifyEvent; isToday: boolean }) {
  if (ev.due_start_at && ev.due_end_at && isToday) {
    return (
      <span className="time-mark range">
        <span>{isoToLocalTime(ev.due_start_at)}</span>
        <i />
        <span>{isoToLocalTime(ev.due_end_at)}</span>
      </span>
    );
  }
  if (ev.due_start_at && isToday) {
    return (
      <span className="time-mark point">
        <span>{isoToLocalTime(ev.due_start_at)}</span>
        <i />
      </span>
    );
  }
  const d = eventDate(ev);
  if (d && !isToday) {
    return (
      <span className="time-mark future" title={d}>
        <span>{d.slice(5)}</span>
        {ev.due_start_at && <em>{isoToLocalTime(ev.due_start_at)}</em>}
      </span>
    );
  }
  if (ev.due_date && !ev.due_start_at) {
    return <span className="time-mark point"><span>{ev.due_date.slice(5)}</span><i /></span>;
  }
  return <span className="time-mark no-time" />;
}

function sortAgenda(events: ClarifyEvent[], today: string): ClarifyEvent[] {
  return [...events].sort((a, b) => {
    const da = eventDate(a) || "9999-99-99";
    const db = eventDate(b) || "9999-99-99";
    const ta = da === today ? "0" : da;
    const tb = db === today ? "0" : db;
    if (ta !== tb) return ta.localeCompare(tb);
    const sa = a.due_start_at || "";
    const sb = b.due_start_at || "";
    return sa.localeCompare(sb);
  });
}

export default function Overlay() {
  const [events, setEvents] = useState<ClarifyEvent[]>([]);
  const [template, setTemplate] = useState<Template>(() => (localStorage.getItem(TEMPLATE_KEY) as Template) || "a");
  const [filter, setFilter] = useState<Filter>("today");
  const [theme] = useState<Theme>(() => (localStorage.getItem("clarify.theme") as Theme) || "pink");
  const [height, setHeight] = useState<number>(() => Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const expandedHeightRef = useRef<number>(Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT);
  const collapsedRef = useRef(collapsed);
  const orbDrag = useRef({ down: false, moved: false, sx: 0, sy: 0 });

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(TEMPLATE_KEY, template);
  }, [template]);

  async function load() {
    setEvents(await listOpen());
  }

  useEffect(() => {
    void load();
    if (!isTauri) return;
    const win = getCurrentWindow();
    // 恢复时 Rust 已设置尺寸；前端再按折叠状态兜底一次
    void win.setSize(new LogicalSize(collapsed ? COLLAPSED_SIZE : EXPANDED_WIDTH, collapsed ? COLLAPSED_SIZE : expandedHeightRef.current));
    let unResized: (() => void) | undefined;
    void win.onResized(({ payload }) => {
      void win.scaleFactor().then((scale) => {
        const logical = Math.round(payload.height / scale);
        if (!collapsedRef.current) {
          setHeight(logical);
          expandedHeightRef.current = logical;
          localStorage.setItem(HEIGHT_KEY, String(logical));
        }
      });
    }).then((fn) => { unResized = fn; });
    let unChanged: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen("clarify://changed", () => { void load(); }).then((fn) => { unChanged = fn; });
    });
    return () => {
      unResized?.();
      unChanged?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function collapse() {
    if (!isTauri) return;
    const win = getCurrentWindow();
    const size = await win.innerSize();
    const scale = await win.scaleFactor();
    const h = Math.max(120, Math.round(size.height / scale));
    expandedHeightRef.current = h;
    localStorage.setItem(HEIGHT_KEY, String(h));
    localStorage.setItem(COLLAPSED_KEY, "1");
    setCollapsed(true);
    await win.setSize(new LogicalSize(COLLAPSED_SIZE, COLLAPSED_SIZE));
  }

  async function expand() {
    if (!isTauri) return;
    const win = getCurrentWindow();
    localStorage.setItem(COLLAPSED_KEY, "0");
    setCollapsed(false);
    setHeight(expandedHeightRef.current);
    await win.setSize(new LogicalSize(EXPANDED_WIDTH, expandedHeightRef.current));
    await win.setFocus();
  }

  function onOrbMouseDown(e: ReactMouseEvent) {
    if (!isTauri) return;
    orbDrag.current = { down: true, moved: false, sx: e.screenX, sy: e.screenY };
    const onMove = (ev: MouseEvent) => {
      if (!orbDrag.current.down) return;
      if (Math.abs(ev.screenX - orbDrag.current.sx) > 4 || Math.abs(ev.screenY - orbDrag.current.sy) > 4) {
        orbDrag.current.moved = true;
        void getCurrentWindow().startDragging();
        cleanup();
      }
    };
    const onUp = () => cleanup();
    const cleanup = () => {
      orbDrag.current.down = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onOrbClick() {
    if (orbDrag.current.moved) {
      orbDrag.current.moved = false;
      return;
    }
    void expand();
  }

  async function startRecording() {
    try {
      recorderRef.current = await startPcmRecorder();
      setRecording(true);
      setNotice("正在听…再点一次麦克风结束");
    } catch (e) {
      setNotice(`麦克风不可用：${String(e)}`);
    }
  }

  async function stopRecording() {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    setRecording(false);
    setTranscribing(true);
    setNotice("正在识别…");
    try {
      const pcm = await rec.stop();
      if (pcm.length < 3200) {
        setNotice("太短了，再说一次？");
        return;
      }
      const text = await transcribeStream(bytesToBase64(pcm));
      const clean = text.trim();
      if (!clean) {
        setNotice("没听清，再说一次？");
        return;
      }
      const outcome = await aiParse(clean);
      setNotice(`已安排 ${outcome.created.length} 项`);
      await load();
      setTimeout(() => setNotice(null), 3200);
    } catch (e) {
      setNotice(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  async function openMain() {
    if (isTauri) await invoke("open_main_today");
  }

  const today = todayISO();
  const todayEvents = useMemo(
    () => events.filter((e) => {
      if (isCount(e)) return true;
      const d = eventDate(e);
      return !d || d === today;
    }),
    [events, today],
  );
  const agenda = useMemo(() => sortAgenda(events, today), [events, today]);
  const list = template === "a" ? agenda : filter === "today" ? todayEvents : events;
  const rowH = 44;
  const chromeH = 46 + 44;
  const capacity = Math.max(1, Math.floor((height - chromeH) / rowH));
  const visible = list.slice(0, capacity);
  const hiddenCount = list.length - visible.length;
  const todayCount = todayEvents.length;

  async function onTaskClick(ev: ClarifyEvent) {
    try {
      if (isCount(ev)) await incrementCount(ev.id);
      else await completeEvent(ev.id);
      await load();
    } catch (e) {
      setNotice(String(e));
    }
  }

  if (collapsed) {
    return (
      <div className="widget-shell collapsed-shell">
        <div
          className="orb-window"
          title="点击展开，拖动移动"
          onMouseDown={onOrbMouseDown}
          onClick={onOrbClick}
        >
          <span className="orb-core" />
          {agenda.length > 0 && <span className="orb-badge">{agenda.length}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="widget-shell">
      <div className="widget">
        <header className="w-head" data-tauri-drag-region title="拖动移动悬浮窗">
          {template === "a" ? (
            <>
              <span className="eyebrow">今天</span>
              <span className="w-date">{fmtShortDate()}</span>
              <span className="w-progress">{todayCount}/{events.length}</span>
            </>
          ) : (
            <div className="w-toggle">
              <button className={filter === "today" ? "on" : ""} onClick={() => setFilter("today")}>今天</button>
              <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>全部</button>
            </div>
          )}
          <button className="w-icon" title="打开 Clarify" onClick={() => void openMain()}>⌂</button>
          <button className="w-tpl" title="切换模板" onClick={() => setTemplate(template === "a" ? "b" : "a")}>
            {template === "a" ? "B" : "A"}
          </button>
          <button className="w-icon w-collapse" title="收起为符号" onClick={() => void collapse()}>—</button>
        </header>

        <div className="w-body">
          {visible.length === 0 && <div className="w-empty">台面干净了。说一句？</div>}
          {visible.map((ev) => (
            <div className="w-row" key={ev.id} onClick={() => void onTaskClick(ev)}>
              <button
                className="w-circle"
                onClick={(e) => { e.stopPropagation(); void onTaskClick(ev); }}
                aria-label="完成"
              />
              <OverlayTimeMark ev={ev} isToday={!eventDate(ev) || eventDate(ev) === today} />
              <span className="w-title">{ev.title}</span>
              {isCount(ev) && <span className="w-chip">{ev.count_progress}/{ev.count_target}</span>}
            </div>
          ))}
        </div>

        <footer className="w-foot">
          <div className="w-actions">
            <button
              className={`w-action mic${recording ? " recording" : ""}`}
              title={recording ? "结束录音" : "语音说一句"}
              disabled={transcribing}
              onClick={() => (recording ? void stopRecording() : void startRecording())}
            >
              <MicIcon />
            </button>
            <button className="w-action" title="打一句 / 打开 Clarify" onClick={() => void openMain()}>
              <PenIcon />
            </button>
          </div>
          {recording || transcribing || notice ? (
            <span className="w-notice">{notice ?? (transcribing ? "正在识别…" : "正在听…")}</span>
          ) : hiddenCount > 0 ? (
            <button className="w-more" onClick={() => void openMain()}>还有 {hiddenCount} 件 ›</button>
          ) : null}
        </footer>

        <div
          className="w-resize"
          title="拖动调整高度"
          onMouseDown={() => {
            if (!isTauri) return;
            void getCurrentWindow().startResizeDragging("South" as never);
          }}
        >
          <span />
        </div>
      </div>
    </div>
  );
}
