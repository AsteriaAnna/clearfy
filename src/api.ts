import { invoke } from "@tauri-apps/api/core";

export type RepeatFreq = "day" | "week" | "month";
export type CountPeriod = "day" | "week";

export interface NewEvent {
  title: string;
  due_date?: string | null;
  due_start_at?: string | null;
  due_end_at?: string | null;
  deadline_at?: string | null;
  repeat_freq?: RepeatFreq | null;
  repeat_interval?: number | null;
  repeat_weekdays?: number[] | null;
  count_target?: number | null;
  count_period?: CountPeriod | null;
}

export interface ClarifyEvent extends NewEvent {
  id: string;
  count_progress: number;
  count_period_key?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const pad = (n: number) => String(n).padStart(2, "0");
function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function atTime(hours: number, minutes = 0): string {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

let mock: ClarifyEvent[] = [
  {
    id: "m1",
    title: "交周报",
    due_start_at: atTime(11, 30),
    count_progress: 0,
    created_at: new Date().toISOString(),
  },
  {
    id: "m2",
    title: "与张总开会",
    due_start_at: atTime(14, 45),
    due_end_at: atTime(15, 30),
    count_progress: 0,
    created_at: new Date().toISOString(),
  },
  {
    id: "m3",
    title: "取快递",
    due_start_at: atTime(16, 30),
    count_progress: 0,
    created_at: new Date().toISOString(),
  },
  {
    id: "m4",
    title: "喝水",
    count_target: 3,
    count_period: "day",
    count_progress: 4,
    count_period_key: todayISO(),
    created_at: new Date().toISOString(),
  },
  {
    id: "m5",
    title: "买牛奶",
    count_progress: 0,
    created_at: new Date().toISOString(),
  },
  {
    id: "m6",
    title: "给妈妈回电话",
    count_progress: 0,
    created_at: new Date().toISOString(),
  },
];

let mockCompleted: ClarifyEvent[] = [];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export async function listOpen(): Promise<ClarifyEvent[]> {
  if (!isTauri) return clone(mock);
  return invoke<ClarifyEvent[]>("list_open");
}

export async function listCompleted(): Promise<ClarifyEvent[]> {
  if (!isTauri) return clone(mockCompleted);
  return invoke<ClarifyEvent[]>("list_completed");
}

export async function createEvent(newEvent: NewEvent): Promise<ClarifyEvent> {
  if (!isTauri) {
    const created = {
      ...newEvent,
      id: `m${Date.now()}`,
      count_progress: 0,
      created_at: new Date().toISOString(),
    } as ClarifyEvent;
    mock.unshift(created);
    return clone(created);
  }
  return invoke<ClarifyEvent>("create_event", { new: newEvent });
}

export async function updateEvent(id: string, newEvent: NewEvent): Promise<ClarifyEvent> {
  if (!isTauri) {
    const idx = mock.findIndex((e) => e.id === id);
    if (idx >= 0) {
      mock[idx] = { ...mock[idx], ...newEvent };
      return clone(mock[idx]);
    }
    throw new Error("not found");
  }
  return invoke<ClarifyEvent>("update_event", { id, new: newEvent });
}

export async function completeEvent(id: string): Promise<ClarifyEvent> {
  if (!isTauri) {
    const idx = mock.findIndex((e) => e.id === id);
    const ev = mock.splice(idx, 1)[0];
    mockCompleted.unshift({ ...ev, completed_at: new Date().toISOString() });
    return clone(ev);
  }
  return invoke<ClarifyEvent>("complete_event", { id });
}

export async function restoreEvent(id: string): Promise<ClarifyEvent> {
  if (!isTauri) {
    const idx = mockCompleted.findIndex((e) => e.id === id);
    const ev = mockCompleted.splice(idx, 1)[0];
    mock.unshift({ ...ev, completed_at: null });
    return clone(ev);
  }
  return invoke<ClarifyEvent>("restore_event", { id });
}

export async function incrementCount(id: string): Promise<ClarifyEvent> {
  if (!isTauri) {
    const ev = mock.find((e) => e.id === id);
    if (!ev) throw new Error("not found");
    ev.count_progress = (ev.count_progress ?? 0) + 1;
    return clone(ev);
  }
  return invoke<ClarifyEvent>("increment_count", { id });
}

export async function deleteEvent(id: string): Promise<void> {
  if (!isTauri) {
    mock = mock.filter((e) => e.id !== id);
    mockCompleted = mockCompleted.filter((e) => e.id !== id);
    return;
  }
  return invoke<void>("delete_event", { id });
}

/** 规则模式：一句话 → 解析 → 创建（无 AI 时的兜底链路）。 */
export async function createFromCapture(text: string): Promise<ClarifyEvent[]> {
  if (!isTauri) {
    const ev = {
      id: `m${Date.now()}`,
      title: text.trim(),
      count_progress: 0,
      created_at: new Date().toISOString(),
    } as ClarifyEvent;
    mock.unshift(ev);
    return [clone(ev)];
  }
  return invoke<ClarifyEvent[]>("create_from_capture", { text });
}

export interface AiStatus {
  deepseek_configured: boolean;
  doubao_configured: boolean;
}

export interface AiParseOutcome {
  created: ClarifyEvent[];
  fallback: boolean;
  warning?: string | null;
}

export async function aiStatus(): Promise<AiStatus> {
  if (!isTauri) return { deepseek_configured: false, doubao_configured: false };
  return invoke<AiStatus>("ai_status");
}

export async function saveAiKeys(deepseekKey: string | null, doubaoKey: string | null): Promise<AiStatus> {
  if (!isTauri) throw new Error("仅桌面应用支持保存 Key");
  return invoke<AiStatus>("save_ai_keys", { deepseekKey, doubaoKey });
}

export async function aiParse(text: string): Promise<AiParseOutcome> {
  if (!isTauri) {
    const created = await createFromCapture(text);
    return { created, fallback: true, warning: "浏览器预览为规则模式" };
  }
  return invoke<AiParseOutcome>("ai_parse", { text });
}

export async function transcribeAudio(audioBase64: string, format: string): Promise<string> {
  if (!isTauri) throw new Error("浏览器预览不支持语音识别");
  return invoke<string>("transcribe_audio", { audioBase64, format });
}

export async function transcribeStream(pcmBase64: string): Promise<string> {
  if (!isTauri) throw new Error("浏览器预览不支持语音识别");
  return invoke<string>("transcribe_stream", { pcmBase64 });
}

export { todayISO };
