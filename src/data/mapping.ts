import { Absence, Compensation, Participant, Plan, Shift, State } from '../domain';

/* Filas de la base de datos (snake_case) ⇄ modelo del dominio (camelCase). */

export interface RowShift {
  date: string; slot_id: string | null; assignee_id: string; original_id: string; performed_by: string | null;
  status: Shift['status']; kind: Shift['kind']; reason: string | null; absence_id: string | null;
  generates_comp: string | null; settles_comp: string | null; morning_by: string | null;
}
export interface RowAbsence { id: string; person_id: string; start_date: string; end_date: string; reason: string | null; cancelled: boolean }
export interface RowComp { id: string; debtor_id: string; creditor_id: string; status: Compensation['status']; note: string | null }
export interface RowParticipant { id: string; name: string; color: string; in_rotation: boolean; sort_order: number }
export interface RowChange {
  id: number; created_at: string; type: string; summary: string; reason: string | null; event_date: string | null;
  affected_count: number; affected?: { date: string; from: string | null; to: string | null }[];
}

export const toShift = (r: RowShift): Shift => ({
  date: r.date, slot: r.slot_id, assignee: r.assignee_id, original: r.original_id, performedBy: r.performed_by,
  status: r.status, kind: r.kind, reason: r.reason, absenceId: r.absence_id, generatesComp: r.generates_comp, settlesComp: r.settles_comp, morningBy: r.morning_by ?? null,
});
export const fromShift = (s: Shift): RowShift => ({
  date: s.date, slot_id: s.slot, assignee_id: s.assignee, original_id: s.original, performed_by: s.performedBy,
  status: s.status, kind: s.kind, reason: s.reason, absence_id: s.absenceId, generates_comp: s.generatesComp, settles_comp: s.settlesComp, morning_by: s.morningBy,
});
export const toAbsence = (r: RowAbsence): Absence => ({ id: r.id, person: r.person_id, start: r.start_date, end: r.end_date, reason: r.reason, cancelled: r.cancelled });
export const toComp = (r: RowComp): Compensation => ({ id: r.id, debtor: r.debtor_id, creditor: r.creditor_id, status: r.status, note: r.note });
export const toParticipant = (r: RowParticipant): Participant => ({ id: r.id, name: r.name, color: r.color, inRotation: r.in_rotation, sortOrder: r.sort_order });

export function buildState(participants: Participant[], shifts: RowShift[], absences: RowAbsence[], comps: RowComp[]): State {
  return {
    order: [...participants].filter((p) => p.inRotation).sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id),
    shifts: shifts.map(toShift).sort((a, b) => (a.date < b.date ? -1 : 1)),
    absences: absences.map(toAbsence),
    comps: comps.map(toComp),
  };
}

export function planToPayload(plan: Plan, expectedVersion: number) {
  return {
    expected_version: expectedVersion,
    settings: plan.settings ?? {},
    participants: (plan.participants ?? []).map((p) => ({ id: p.id, name: p.name, color: p.color, in_rotation: p.inRotation, sort_order: p.sortOrder })),
    shifts: plan.shifts.map(fromShift),
    delete_dates: plan.deleteDates,
    absences: plan.absences.map((a) => ({ id: a.id, person_id: a.person, start_date: a.start, end_date: a.end, reason: a.reason, cancelled: a.cancelled })),
    compensations: plan.comps.map((c) => ({ id: c.id, debtor_id: c.debtor, creditor_id: c.creditor, status: c.status, note: c.note })),
    event: plan.event && {
      type: plan.event.type, summary: plan.event.summary, reason: plan.event.reason, date: plan.event.date,
      affected: plan.event.affected, affected_count: plan.event.affectedCount ?? plan.event.affected.length,
    },
  };
}
