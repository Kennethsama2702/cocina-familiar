import { ChangeEvent, Ctx, DomainError, Plan, Shift, State } from './types';

const MAX_AFFECTED = 90;

function sameShift(a: Shift, b: Shift): boolean {
  return (
    a.date === b.date &&
    a.slot === b.slot &&
    a.assignee === b.assignee &&
    a.original === b.original &&
    a.performedBy === b.performedBy &&
    a.status === b.status &&
    a.kind === b.kind &&
    a.reason === b.reason &&
    a.absenceId === b.absenceId &&
    a.generatesComp === b.generatesComp &&
    a.settlesComp === b.settlesComp &&
    a.morningBy === b.morningBy
  );
}

/**
 * Convierte la diferencia entre dos estados en un plan transaccional mínimo:
 * solo las filas que cambian. Si alguna fila pasada cambiara, se aborta (red de seguridad
 * adicional al bloqueo que ya aplica la base de datos).
 */
export function buildPlan(before: State, after: State, event: ChangeEvent | null, ctx: Ctx): Plan {
  const beforeByDate = new Map(before.shifts.map((s) => [s.date, s] as const));
  const afterDates = new Set(after.shifts.map((s) => s.date));
  const shifts: Shift[] = [];
  const deleteDates: string[] = [];
  const affected: { date: string; from: string | null; to: string | null }[] = [];

  for (const a of after.shifts) {
    const b = beforeByDate.get(a.date);
    if (b && sameShift(a, b)) continue;
    if (a.date < ctx.today) throw new DomainError('PAST_LOCKED', `La operación modificaría un día pasado (${a.date}).`);
    shifts.push(a);
    if (!b || b.assignee !== a.assignee || b.kind !== a.kind) {
      affected.push({ date: a.date, from: b?.assignee ?? null, to: a.assignee });
    }
  }
  for (const b of before.shifts) {
    if (afterDates.has(b.date)) continue;
    if (b.date < ctx.today) throw new DomainError('PAST_LOCKED', `La operación eliminaría un día pasado (${b.date}).`);
    deleteDates.push(b.date);
    affected.push({ date: b.date, from: b.assignee, to: null });
  }

  const beforeAbs = new Map(before.absences.map((x) => [x.id, x] as const));
  const absences = after.absences.filter((x) => {
    const o = beforeAbs.get(x.id);
    return !o || o.person !== x.person || o.start !== x.start || o.end !== x.end || o.reason !== x.reason || o.cancelled !== x.cancelled;
  });
  const beforeComps = new Map(before.comps.map((x) => [x.id, x] as const));
  const comps = after.comps.filter((x) => {
    const o = beforeComps.get(x.id);
    return !o || o.debtor !== x.debtor || o.creditor !== x.creditor || o.status !== x.status || o.note !== x.note;
  });

  const isEvent = event
    ? { ...event, affected: affected.slice(0, MAX_AFFECTED), affectedCount: affected.length }
    : null;
  const plan: Plan = { shifts, deleteDates, absences, comps, event: isEvent };
  return plan;
}

export function isEmptyPlan(p: Plan): boolean {
  return p.shifts.length === 0 && p.deleteDates.length === 0 && p.absences.length === 0 && p.comps.length === 0 && !p.event;
}
