import { invoke } from "@tauri-apps/api/core";
import { todayISO } from "./lib/time";

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

export interface AiParseOutcome {
  created: ClarifyEvent[];
  fallback: boolean;
  warning?: string | null;
}

export interface CodeStatus {
  plan: string;
  expires_at: number;
  parse_limit: number;
  parse_used: number;
  parse_left: number;
  voice_limit: number;
  voice_used: number;
  voice_left: number;
}

export interface QuotaStatus {
  date: string;
  free_parse_limit: number;
  free_parse_used: number;
  free_parse_left: number;
  free_voice_limit: number;
  free_voice_used: number;
  free_voice_left: number;
  code: CodeStatus | null;
}

export async function quotaStatus(): Promise<QuotaStatus> {
  if (!isTauri) {
    return {
      date: todayISO(),
      free_parse_limit: 5, free_parse_used: 0, free_parse_left: 5,
      free_voice_limit: 30, free_voice_used: 0, free_voice_left: 30,
      code: null,
    };
  }
  return invoke<QuotaStatus>("quota_status");
}

export async function saveActivationCode(code: string): Promise<QuotaStatus> {
  if (!isTauri) throw new Error("浏览器预览不支持激活码");
  return invoke<QuotaStatus>("save_activation_code", { code });
}

export async function aiParse(text: string): Promise<AiParseOutcome> {
  if (!isTauri) {
    const created = await createFromCapture(text);
    return { created, fallback: true, warning: "浏览器预览为规则模式" };
  }
  return invoke<AiParseOutcome>("ai_parse", { text });
}

export async function transcribeStream(pcmBase64: string): Promise<string> {
  if (!isTauri) throw new Error("浏览器预览不支持语音识别");
  return invoke<string>("transcribe_stream", { pcmBase64 });
}

export async function quitApp(): Promise<void> {
  if (!isTauri) return;
  return invoke<void>("quit_app");
}
