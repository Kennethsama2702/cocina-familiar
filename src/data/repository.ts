import { Participant, Plan, State } from '../domain';
import { client } from '../lib/supabase';
import { RowAbsence, RowChange, RowComp, RowParticipant, RowShift, buildState, planToPayload, toParticipant } from './mapping';

export interface Settings { showHistory: boolean; showReasons: boolean; rotationStart: string | null; version: number }

export interface Snapshot {
  role: 'admin' | 'visitor';
  /** Fecha de hoy según el SERVIDOR (America/Guayaquil), no según el dispositivo. */
  today: string;
  participants: Participant[];
  state: State;
  changes: RowChange[];
  settings: Settings;
  shareToken?: string;
}

export class AppError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const MESSAGES: Record<string, string> = {
  FORBIDDEN: 'No tienes permiso para hacer este cambio.',
  PAST_LOCKED: 'Los días pasados no se pueden modificar.',
  STALE_VERSION: 'El calendario cambió en otro dispositivo. Se recargó; revisa y vuelve a intentarlo.',
  CALENDAR_GAP: 'El cambio dejaría huecos en el calendario y fue rechazado.',
  ABSENT_ASSIGNED: 'El cambio asignaría una tarea a una persona ausente y fue rechazado.',
  INVALID_LINK: 'El enlace no es válido o fue reemplazado. Pide uno nuevo al administrador.',
};

export function friendlyError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const raw = (e as { message?: string })?.message ?? String(e);
  for (const k of Object.keys(MESSAGES)) if (raw.includes(k)) return new AppError(k, MESSAGES[k]!);
  if (/Failed to fetch|NetworkError|network/i.test(raw)) return new AppError('NETWORK', 'Sin conexión con el servidor. Revisa tu internet.');
  if (/duplicate key|unique|exclusion/i.test(raw)) return new AppError('DUPLICATE', 'Ese registro ya existe o se solapa con otro.');
  return new AppError('UNKNOWN', raw.replace(/^[A-Z_]+:\s*/, ''));
}

interface CalendarJson {
  today: string;
  settings: { show_history: boolean; show_reasons: boolean; rotation_start: string | null; version: number };
  participants: RowParticipant[];
  shifts: RowShift[];
  absences: RowAbsence[];
  compensations: RowComp[];
  changes: RowChange[];
}

function fromCalendar(json: CalendarJson, role: Snapshot['role']): Snapshot {
  const participants = json.participants.map(toParticipant);
  return {
    role,
    today: json.today,
    participants,
    state: buildState(participants, json.shifts, json.absences, json.compensations),
    changes: json.changes,
    settings: { showHistory: json.settings.show_history, showReasons: json.settings.show_reasons, rotationStart: json.settings.rotation_start, version: Number(json.settings.version) },
  };
}

/** Visitantes: solo la función get_calendar(token); nunca tocan las tablas. */
export async function loadVisitor(token: string): Promise<Snapshot> {
  const { data, error } = await client().rpc('get_calendar', { p_token: token });
  if (error) throw friendlyError(error);
  return fromCalendar(data as CalendarJson, 'visitor');
}

export async function currentSession() {
  const { data } = await client().auth.getSession();
  return data.session;
}

export async function signIn(email: string, password: string) {
  const { error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw new AppError('AUTH', 'Correo o contraseña incorrectos.');
}

export async function signOut() { await client().auth.signOut(); }

export async function isAdmin(): Promise<boolean> {
  const { data, error } = await client().rpc('is_admin');
  if (error) return false;
  return data === true;
}

async function selectAll<T>(table: string, order: string, ascending = true): Promise<T[]> {
  // PostgREST limita a 1000 filas por petición: se pagina.
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client().from(table).select('*').order(order, { ascending }).range(from, from + 999);
    if (error) throw friendlyError(error);
    out.push(...(data as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadAdmin(): Promise<Snapshot> {
  const c = client();
  const clock = await c.rpc('server_clock');
  if (clock.error) throw friendlyError(clock.error);
  const [participants, shifts, absences, comps, settings, changes] = await Promise.all([
    selectAll<RowParticipant>('participants', 'sort_order'),
    selectAll<RowShift>('shifts', 'date'),
    selectAll<RowAbsence>('absences', 'start_date'),
    selectAll<RowComp>('compensations', 'created_at'),
    c.from('app_settings').select('*').single(),
    c.from('change_log').select('*').order('id', { ascending: false }).limit(300),
  ]);
  if (settings.error) throw friendlyError(settings.error);
  if (changes.error) throw friendlyError(changes.error);
  const s = settings.data as { show_history: boolean; show_reasons: boolean; rotation_start: string | null; version: number; share_token: string };
  const parts = participants.map(toParticipant);
  return {
    role: 'admin',
    today: (clock.data as { today: string }).today,
    participants: parts,
    state: buildState(parts, shifts, absences, comps),
    changes: changes.data as RowChange[],
    settings: { showHistory: s.show_history, showReasons: s.show_reasons, rotationStart: s.rotation_start, version: Number(s.version) },
    shareToken: s.share_token,
  };
}

/** Única vía de escritura: la función transaccional apply_change (valida admin, pasado, invariantes). */
export async function applyPlan(plan: Plan, expectedVersion: number): Promise<void> {
  const { error } = await client().rpc('apply_change', { p_payload: planToPayload(plan, expectedVersion) });
  if (error) throw friendlyError(error);
}

export async function rotateShareToken(): Promise<string> {
  const { data, error } = await client().rpc('rotate_share_token');
  if (error) throw friendlyError(error);
  return data as string;
}
