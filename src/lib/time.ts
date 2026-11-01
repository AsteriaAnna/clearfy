import type { ClarifyEvent } from "../api";

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isoToLocalTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const CN_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const EN_WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
export const EN_MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

export function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${pad(m)}.${pad(d)} ${CN_WEEKDAYS[date.getDay()]}`;
}

export function fmtShortDate(): string {
  const d = new Date();
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${CN_WEEKDAYS[d.getDay()]}`;
}

export function eventDate(ev: ClarifyEvent): string | null {
  if (ev.due_date) return ev.due_date;
  if (ev.due_start_at) return isoToLocalDate(ev.due_start_at);
  return null;
}

export function isCount(ev: ClarifyEvent): boolean {
  return ev.count_target != null;
}

export function isTimed(ev: ClarifyEvent): boolean {
  return !!ev.due_start_at;
}
