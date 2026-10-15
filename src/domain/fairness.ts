import { addDays } from './dates';
import { PersonId, State } from './types';

/**
 * EQUIDAD
 *
 * En los viajes la equidad no depende de ningún reparto discrecional: quien viaja sale de la fila,
 * los siguientes se adelantan y quien viaja recupera sus turnos al volver. Cada persona pierde
 * y recupera exactamente los mismos turnos, así que las cuentas se conservan por construcción y
 * no interviene el azar (ver `reconcile` en operations.ts).
 *
 * Este módulo solo calcula la penalización por turnos pegados, que se usa para proponer fechas
 * de las compensaciones manuales (cuando el administrador cede un turno a otra persona).
 */

/** +2 si la persona ya tiene turno el día anterior o posterior; +1 si lo tiene a dos días. */
export function proximityPenalty(state: State, person: PersonId, date: string, skipDate?: string): number {
  const at = (d: string) => {
    if (d === skipDate) return false;
    const s = state.shifts.find((x) => x.date === d);
    return !!s && s.assignee === person && s.status !== 'skipped';
  };
  let p = 0;
  if (at(addDays(date, -1)) || at(addDays(date, 1))) p += 2;
  if (at(addDays(date, -2)) || at(addDays(date, 2))) p += 1;
  return p;
}
