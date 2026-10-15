import { TIMEZONE } from './types';

/**
 * Las fechas de calendario se manejan como cadenas YYYY-MM-DD y se operan en UTC,
 * de modo que nunca dependen de la zona horaria del dispositivo.
 */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toUtc(s: string): number {
  return Date.parse(`${s}T00:00:00Z`);
}

export function addDays(s: string, n: number): string {
  return new Date(toUtc(s) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Diferencia en días: b - a. */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** 0 = lunes … 6 = domingo. */
export function weekdayMon0(s: string): number {
  const d = new Date(toUtc(s)).getUTCDay(); // 0 = domingo
  return (d + 6) % 7;
}

export function monthKey(s: string): string {
  return s.slice(0, 7);
}

export function firstOfMonth(s: string): string {
  return `${s.slice(0, 7)}-01`;
}

export function addMonths(monthStart: string, n: number): string {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

export function daysInMonth(monthStart: string): number {
  return diffDays(monthStart, addMonths(monthStart, 1));
}

export function* dateRange(start: string, end: string): Generator<string> {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

const ecFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha (YYYY-MM-DD) de un instante en America/Guayaquil. */
export function dateInEcuador(instant: Date | number): string {
  return ecFormatter.format(instant);
}

const longFmt = new Intl.DateTimeFormat('es-EC', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const shortFmt = new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const monthFmt = new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', month: 'long', year: 'numeric' });

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const formatLong = (s: string) => cap(longFmt.format(new Date(toUtc(s))));
export const formatShort = (s: string) => cap(shortFmt.format(new Date(toUtc(s))).replace('.', ''));
export const formatMonth = (s: string) => cap(monthFmt.format(new Date(toUtc(s))));

export const WEEKDAYS_ES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] as const;
