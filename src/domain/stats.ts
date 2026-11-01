import { effectivePerformer } from './core';
import { addDays } from './dates';
import { Compensation, CompStatus, Ctx, MOM, PersonId, Shift, State } from './types';

export interface PersonStats {
  person: PersonId;
  /** Tareas cuyo responsable original era esta persona (ya resueltas; una por día). */
  assigned: number;
  /** Tareas realmente realizadas por la persona (incluye las que cubrió). */
  done: number;
  /** De las realizadas, cuántas eran originalmente de otra persona de la rotación. */
  coveredForOthers: number;
  /** Asignadas a ella pero realizadas por otra persona (o por nadie). */
  notDoneByMe: number;
  /** Turnos pendientes en los próximos 30 días. */
  upcoming30: number;
  /** Compensaciones pendientes o programadas que debe. */
  owes: number;
  /** Compensaciones pendientes o programadas que le deben. */
  isOwed: number;
}

function resolved(s: Shift, ctx: Ctx): boolean {
  return s.date < ctx.today || s.status !== 'scheduled';
}

/**
 * Cada día cuenta UNA sola vez en "asignadas" (por su responsable original) y UNA sola vez
 * en "realizadas" (por quien efectivamente la hizo), aunque haya sido reasignada varias veces.
 * Un día pasado sin registro se da por realizado por su responsable; un día marcado como
 * "no realizado" no cuenta como limpieza hecha.
 */
export function computeStats(state: State, ctx: Ctx): Record<PersonId, PersonStats> {
  const ids = [...state.order, MOM];
  const out: Record<PersonId, PersonStats> = {};
  for (const id of ids) {
    out[id] = { person: id, assigned: 0, done: 0, coveredForOthers: 0, notDoneByMe: 0, upcoming30: 0, owes: 0, isOwed: 0 };
  }
  const horizon = addDays(ctx.today, 30);
  for (let i = 0; i < state.shifts.length; i++) {
    const s = state.shifts[i]!;
    // Cocinó por la mañana el turno pendiente de ayer: cuenta como asignado y realizado de esa persona (una vez).
    if (s.morningBy && s.date <= ctx.today) {
      const owner = state.shifts[i - 1]?.original; // el turno pendiente era el del día anterior ("nadie cocinó")
      if (owner && out[owner]) out[owner]!.assigned++;
      if (out[s.morningBy]) {
        out[s.morningBy]!.done++;
        if (owner && owner !== s.morningBy && owner !== MOM) out[s.morningBy]!.coveredForOthers++;
      }
      if (owner && owner !== s.morningBy && out[owner] && owner !== MOM) out[owner]!.notDoneByMe++;
    }
    if (s.status === 'skipped') continue; // nadie cocinó: el turno se trasladó, no cuenta ni como asignado ni como hecho
    if (resolved(s, ctx) && s.date <= ctx.today) {
      const orig = out[s.original];
      if (orig) orig.assigned++;
      const who = effectivePerformer(s, ctx);
      if (who && out[who]) {
        out[who]!.done++;
        if (who !== s.original && s.original !== MOM) out[who]!.coveredForOthers++;
      }
      if (orig && who !== s.original && s.original !== MOM) orig.notDoneByMe++;
    } else if (s.status === 'scheduled' && s.date >= ctx.today && s.date <= horizon) {
      const a = out[s.assignee];
      if (a) a.upcoming30++;
    }
  }
  for (const c of state.comps) {
    if (c.status === 'pending' || c.status === 'scheduled') {
      if (out[c.debtor]) out[c.debtor]!.owes++;
      if (out[c.creditor]) out[c.creditor]!.isOwed++;
    }
  }
  return out;
}

export interface CompView extends Compensation {
  /** Fecha del turno que fue cubierto (origen de la deuda). */
  originDate: string | null;
  /** Fecha programada para compensar. */
  settleDate: string | null;
}

export function compViews(state: State): CompView[] {
  const gen = new Map<string, string>();
  const set = new Map<string, string>();
  for (const s of state.shifts) {
    if (s.generatesComp) gen.set(s.generatesComp, s.date);
    if (s.settlesComp) set.set(s.settlesComp, s.date);
  }
  return state.comps.map((c) => ({ ...c, originDate: gen.get(c.id) ?? null, settleDate: set.get(c.id) ?? null }));
}

export function compStatusLabel(s: CompStatus): string {
  return { pending: 'Pendiente', scheduled: 'Programada', done: 'Realizada', cancelled: 'Cancelada' }[s];
}

/** Próximo turno (desde hoy, incluido) de una persona. */
export function nextShiftOf(state: State, person: PersonId, ctx: Ctx): Shift | undefined {
  return state.shifts.find((s) => s.date >= ctx.today && s.status === 'scheduled' && s.assignee === person);
}

export function upcomingAbsences(state: State, ctx: Ctx) {
  return state.absences
    .filter((a) => !a.cancelled && a.end >= ctx.today)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}
