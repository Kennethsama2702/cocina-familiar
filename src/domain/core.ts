import { addDays, diffDays } from './dates';
import {
  Absence,
  Compensation,
  Ctx,
  DomainError,
  MOM,
  PersonId,
  Shift,
  State,
} from './types';

export function cloneState(s: State): State {
  return {
    order: [...s.order],
    shifts: s.shifts.map((x) => ({ ...x })),
    absences: s.absences.map((x) => ({ ...x })),
    comps: s.comps.map((x) => ({ ...x })),
  };
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function successor(order: PersonId[], p: PersonId): PersonId {
  const i = order.indexOf(p);
  if (i < 0) throw new DomainError('INVALID', `${p} no pertenece a la rotación`);
  return order[(i + 1) % order.length]!;
}

export function rotationShift(date: string, slot: PersonId): Shift {
  return {
    date,
    slot,
    assignee: slot,
    original: slot,
    performedBy: null,
    status: 'scheduled',
    kind: 'rotation',
    reason: null,
    absenceId: null,
    generatesComp: null,
    settlesComp: null,
    morningBy: null,
  };
}

export function momShift(date: string, reason: string | null): Shift {
  return {
    date,
    slot: null,
    assignee: MOM,
    original: MOM,
    performedBy: null,
    status: 'scheduled',
    kind: 'mom',
    reason,
    absenceId: null,
    generatesComp: null,
    settlesComp: null,
    morningBy: null,
  };
}

export function sortShifts(shifts: Shift[]): Shift[] {
  return shifts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function getShift(state: State, date: string): Shift | undefined {
  // Las filas están ordenadas y sin huecos: búsqueda directa con respaldo lineal.
  const first = state.shifts[0];
  if (first) {
    const idx = diffDays(first.date, date);
    const cand = state.shifts[idx];
    if (cand && cand.date === date) return cand;
  }
  return state.shifts.find((s) => s.date === date);
}

export function requireShift(state: State, date: string): Shift {
  const s = getShift(state, date);
  if (!s) throw new DomainError('NOT_FOUND', `No existe un turno para ${date}`);
  return s;
}

export function activeAbsences(state: State): Absence[] {
  return state.absences.filter((a) => !a.cancelled);
}

export function isAbsent(state: State, person: PersonId, date: string): boolean {
  return state.absences.some((a) => !a.cancelled && a.person === person && a.start <= date && date <= a.end);
}

export function absenceFor(state: State, person: PersonId, date: string): Absence | undefined {
  return state.absences.find((a) => !a.cancelled && a.person === person && a.start <= date && date <= a.end);
}

export function getComp(state: State, id: string): Compensation {
  const c = state.comps.find((x) => x.id === id);
  if (!c) throw new DomainError('NOT_FOUND', 'Compensación no encontrada');
  return c;
}

export function assertEditable(date: string, ctx: Ctx): void {
  if (date < ctx.today) {
    throw new DomainError('PAST_LOCKED', 'Los días pasados no se pueden modificar.');
  }
}

export function assertRotationPerson(state: State, p: PersonId): void {
  if (!state.order.includes(p)) throw new DomainError('INVALID', 'La persona no pertenece a la rotación.');
}

/**
 * Quién cuenta como autor real de la tarea:
 *  - registrada (done): quien la realizó;
 *  - día pasado sin registrar: se da por realizada por el responsable (confirmación automática);
 *  - skipped, hoy o futuro sin registrar: nadie todavía.
 */
export function effectivePerformer(s: Shift, ctx: Ctx): PersonId | null {
  if (s.status === 'done') return s.performedBy ?? s.assignee;
  if (s.status === 'skipped') return null;
  if (s.date < ctx.today) return s.assignee;
  return null;
}

export function lastSlot(shifts: Shift[]): PersonId | null {
  for (let i = shifts.length - 1; i >= 0; i--) {
    const s = shifts[i]!;
    if (s.slot) return s.slot;
  }
  return null;
}

export function lastDate(state: State): string {
  const l = state.shifts[state.shifts.length - 1];
  if (!l) throw new DomainError('INVALID', 'El calendario todavía no está configurado.');
  return l.date;
}

/** Comprueba las invariantes estructurales. Lanza si algo está mal. */
export function assertInvariants(state: State): void {
  const rows = state.shifts;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (i > 0 && r.date !== addDays(rows[i - 1]!.date, 1)) {
      throw new DomainError('CONFLICT', `Hueco o desorden en el calendario cerca de ${r.date}`);
    }
  }
  const gen = new Set<string>();
  const set = new Set<string>();
  for (const r of rows) {
    if (r.generatesComp) {
      if (gen.has(r.generatesComp)) throw new DomainError('DUPLICATE', 'Compensación duplicada');
      gen.add(r.generatesComp);
    }
    if (r.settlesComp) {
      if (set.has(r.settlesComp)) throw new DomainError('DUPLICATE', 'Compensación saldada dos veces');
      set.add(r.settlesComp);
    }
  }
}
