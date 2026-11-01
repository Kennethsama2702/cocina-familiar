-- =====================================================================
-- EMPEZAR DE CERO (DESTRUCTIVO). Borra TODO el calendario: turnos (también los
-- pasados), ausencias, compensaciones e historial de cambios.
-- NO borra integrantes, administradores ni el enlace compartido.
-- Después de ejecutarlo, al abrir la app como administrador aparece la pantalla
-- de configuración inicial para crear una rotación nueva.
-- Ejecutar en Supabase → SQL Editor. No se puede deshacer.
-- =====================================================================
begin;
alter table public.shifts       disable trigger shifts_lock_past;
alter table public.absences     disable trigger absences_no_delete;
alter table public.compensations disable trigger compensations_no_delete;
alter table public.change_log   disable trigger change_log_immutable;

delete from public.shifts;
delete from public.compensations;
delete from public.absences;
delete from public.change_log;
update public.app_settings set rotation_start = null, version = version + 1, updated_at = now() where id;

alter table public.shifts       enable trigger shifts_lock_past;
alter table public.absences     enable trigger absences_no_delete;
alter table public.compensations enable trigger compensations_no_delete;
alter table public.change_log   enable trigger change_log_immutable;
commit;
