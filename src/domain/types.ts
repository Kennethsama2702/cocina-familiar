/** Tipos del dominio. Sin dependencias de React ni de Supabase. */

export type PersonId = string;

/** Id fijo de mamá: no forma parte de la rotación, solo hace excepciones y coberturas. */
export const MOM: PersonId = 'mom';

export const TIMEZONE = 'America/Guayaquil';

export type ShiftKind = 'rotation' | 'mom' | 'cover' | 'manual' | 'compensation';
export type ShiftStatus = 'scheduled' | 'done' | 'skipped';
export type CompStatus = 'pending' | 'scheduled' | 'done' | 'cancelled';

export interface Participant {
  id: PersonId;
  name: string;
  color: string;
  inRotation: boolean;
  sortOrder: number;
}

/**
 * Una fila por día. Invariante: desde el primer hasta el último día NO hay huecos
 * y cada fecha tiene exactamente un turno.
 */
export interface Shift {
  date: string; // YYYY-MM-DD
  /** Dueño del hueco de la rotación (null en turnos de mamá). */
  slot: PersonId | null;
  /** Quién tiene asignada la tarea ahora. */
  assignee: PersonId;
  /** Quién la tenía asignada originalmente (nunca se sobrescribe). */
  original: PersonId;
  /** Quién la realizó de verdad (solo se registra el mismo día). */
  performedBy: PersonId | null;
  status: ShiftStatus;
  kind: ShiftKind;
  reason: string | null;
  absenceId: string | null;
  /** Compensación generada por este turno (este turno fue cubierto por otro). */
  generatesComp: string | null;
  /** Compensación que se salda con este turno. */
  settlesComp: string | null;
  /** Quien cocinó por la mañana de este día el turno pendiente del día anterior (nadie cocinó anoche). */
  morningBy: PersonId | null;
}

export interface Absence {
  id: string;
  person: PersonId;
  start: string;
  end: string;
  reason: string | null;
  cancelled: boolean;
}

export interface Compensation {
  id: string;
  /** Quien debe compensar (estuvo ausente). */
  debtor: PersonId;
  /** Quien cubrió y tiene un turno a favor. */
  creditor: PersonId;
  status: CompStatus;
  note: string | null;
}

export interface State {
  /** Orden de la rotación (ids de personas con inRotation). */
  order: PersonId[];
  shifts: Shift[];
  absences: Absence[];
  comps: Compensation[];
}

export type EventType =
  | 'setup'
  | 'rebuild'
  | 'mom_exception'
  | 'mom_cancelled'
  | 'manual_change'
  | 'performed'
  | 'absence'
  | 'absence_cancelled'
  | 'compensation_scheduled'
  | 'compensation_cancelled'
  | 'settings'
  | 'share_link';

export interface Affected {
  date: string;
  from: PersonId | null;
  to: PersonId | null;
}

export interface ChangeEvent {
  type: EventType;
  summary: string;
  reason: string | null;
  date: string | null;
  /** Asignaciones futuras afectadas (puede venir truncada; ver affectedCount). */
  affected: Affected[];
  affectedCount?: number;
}

export interface Ctx {
  /** Fecha actual en America/Guayaquil (YYYY-MM-DD), proporcionada por el reloj del servidor. */
  today: string;
  /** Nombres para redactar el resumen del historial (opcional; por defecto se usan los ids). */
  names?: Record<PersonId, string>;
}

export interface OpResult {
  state: State;
  event: ChangeEvent;
}

export type DomainErrorCode =
  | 'PAST_LOCKED'
  | 'INVALID'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'UNAVAILABLE';

export class DomainError extends Error {
  code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Cambios que hay que enviar a la base de datos en una sola transacción. */
export interface Plan {
  shifts: Shift[];
  deleteDates: string[];
  absences: Absence[];
  comps: Compensation[];
  event: ChangeEvent | null;
  settings?: { rotation_start?: string; show_history?: boolean; show_reasons?: boolean };
  /** Integrantes nuevos o reordenados (se guardan en la misma transacción). */
  participants?: Participant[];
}
