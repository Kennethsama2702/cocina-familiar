-- =====================================================================
-- 0002 · "Cocinó por la mañana" + alta de integrantes
--   · shifts.morning_by: quién cocinó por la mañana el turno pendiente de ayer.
--   · get_calendar / apply_change actualizadas (apply_change admite `participants`).
-- Ejecutar UNA vez en Supabase → SQL Editor, antes de subir el código nuevo.
-- =====================================================================
alter table public.shifts add column if not exists morning_by text references public.participants (id);

create or replace function public.get_calendar(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  cfg public.app_settings;
  t   date := public.today_ec();
begin
  select * into cfg from public.app_settings where id;
  if p_token is null or length(p_token) < 32 or p_token <> cfg.share_token then
    raise exception 'INVALID_LINK' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'now', now(),
    'today', t,
    'settings', jsonb_build_object(
      'show_history', cfg.show_history,
      'show_reasons', cfg.show_reasons,
      'rotation_start', cfg.rotation_start,
      'version', cfg.version),
    'participants', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'color', p.color,
               'in_rotation', p.in_rotation, 'sort_order', p.sort_order) order by p.sort_order), '[]'::jsonb)
        from public.participants p),
    'shifts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', sh.date, 'slot_id', sh.slot_id, 'assignee_id', sh.assignee_id,
               'original_id', sh.original_id, 'performed_by', sh.performed_by,
               'status', sh.status, 'kind', sh.kind,
               'reason', case when cfg.show_reasons then sh.reason else null end,
               'absence_id', sh.absence_id, 'generates_comp', sh.generates_comp,
               'settles_comp', sh.settles_comp, 'morning_by', sh.morning_by) order by sh.date), '[]'::jsonb)
        from public.shifts sh
       where cfg.show_history or sh.date >= t),
    'absences', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', a.id, 'person_id', a.person_id, 'start_date', a.start_date, 'end_date', a.end_date,
               'reason', case when cfg.show_reasons then a.reason else null end,
               'cancelled', false) order by a.start_date), '[]'::jsonb)
        from public.absences a
       where not a.cancelled and (cfg.show_history or a.end_date >= t)),
    'compensations', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'debtor_id', c.debtor_id, 'creditor_id', c.creditor_id,
               'status', c.status, 'note', null) order by c.created_at), '[]'::jsonb)
        from public.compensations c
       where c.status <> 'cancelled'),
    'changes', case when cfg.show_history then (
      select coalesce(jsonb_agg(x order by x.id desc), '[]'::jsonb) from (
        select l.id, l.created_at, l.type, l.summary,
               case when cfg.show_reasons then l.reason else null end as reason,
               l.event_date, l.affected_count
          from public.change_log l
         order by l.id desc limit 200) x)
      else '[]'::jsonb end
  );
end $$;

create or replace function public.apply_change(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today   date := public.today_ec();
  v_version bigint;
  r         jsonb;
  v_event   jsonb := p_payload -> 'event';
  v_prev    public.absences;
  v_comp    public.compensations;
  v_id      text;
  v_name    text;
  v_color   text;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: solo el administrador puede modificar el calendario' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID: carga útil no válida';
  end if;
  if octet_length(p_payload::text) > 3000000 then
    raise exception 'INVALID: carga útil demasiado grande';
  end if;

  -- Una sola modificación a la vez + control de versión (evita pisar cambios de otro dispositivo).
  perform pg_advisory_xact_lock(727001);
  select version into v_version from public.app_settings where id;
  if (p_payload ->> 'expected_version')::bigint is distinct from v_version then
    raise exception 'STALE_VERSION: el calendario cambió desde que lo cargaste; recarga e inténtalo de nuevo';
  end if;

  -- Configuración (lista blanca de campos)
  if jsonb_typeof(p_payload -> 'settings') = 'object' then
    update public.app_settings set
      rotation_start = coalesce((p_payload -> 'settings' ->> 'rotation_start')::date, rotation_start),
      show_history   = coalesce((p_payload -> 'settings' ->> 'show_history')::boolean, show_history),
      show_reasons   = coalesce((p_payload -> 'settings' ->> 'show_reasons')::boolean, show_reasons)
    where id;
  end if;

  -- Integrantes: solo se pueden AÑADIR nuevos o cambiar nombre/color/orden/rotación de los existentes.
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'participants', '[]'::jsonb)) loop
    v_id := r ->> 'id'; v_name := btrim(coalesce(r ->> 'name', '')); v_color := r ->> 'color';
    if v_id is null or v_id !~ '^[a-z0-9_]{2,24}$' or v_id = 'mom' then
      raise exception 'INVALID: identificador de integrante no válido';
    end if;
    if char_length(v_name) < 1 or char_length(v_name) > 30 then
      raise exception 'INVALID: el nombre debe tener entre 1 y 30 caracteres';
    end if;
    if v_color is null or v_color !~ '^#[0-9A-Fa-f]{6}$' then
      raise exception 'INVALID: color no válido';
    end if;
    insert into public.participants (id, name, color, in_rotation, sort_order)
    values (v_id, v_name, v_color, coalesce((r ->> 'in_rotation')::boolean, true), coalesce((r ->> 'sort_order')::int, 99))
    on conflict (id) do update set name = excluded.name, color = excluded.color,
      in_rotation = excluded.in_rotation, sort_order = excluded.sort_order;
  end loop;

  -- Ausencias (no se borran; se cancelan). Solo las que no han terminado.
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'absences', '[]'::jsonb)) loop
    select * into v_prev from public.absences where id = (r ->> 'id')::uuid;
    if found then
      if v_prev.end_date < v_today then
        raise exception 'PAST_LOCKED: la ausencia ya terminó';
      end if;
      update public.absences set cancelled = coalesce((r ->> 'cancelled')::boolean, cancelled)
       where id = v_prev.id;
    else
      if (r ->> 'end_date')::date < v_today then
        raise exception 'PAST_LOCKED: no se pueden registrar ausencias que ya terminaron';
      end if;
      if not exists (select 1 from public.participants where id = r ->> 'person_id' and in_rotation) then
        raise exception 'INVALID: la persona no pertenece a la rotación';
      end if;
      insert into public.absences (id, person_id, start_date, end_date, reason, cancelled)
      values ((r ->> 'id')::uuid, r ->> 'person_id', (r ->> 'start_date')::date, (r ->> 'end_date')::date,
              nullif(r ->> 'reason', ''), coalesce((r ->> 'cancelled')::boolean, false));
    end if;
  end loop;

  -- Compensaciones (una cancelada no se reabre)
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'compensations', '[]'::jsonb)) loop
    select * into v_comp from public.compensations where id = (r ->> 'id')::uuid;
    if found then
      if v_comp.status = 'cancelled' and (r ->> 'status') <> 'cancelled' then
        raise exception 'CONFLICT: una compensación cancelada no se puede reabrir';
      end if;
      update public.compensations set
        creditor_id = r ->> 'creditor_id',
        status      = r ->> 'status',
        note        = nullif(r ->> 'note', ''),
        updated_at  = now()
      where id = v_comp.id;
    else
      insert into public.compensations (id, debtor_id, creditor_id, status, note)
      values ((r ->> 'id')::uuid, r ->> 'debtor_id', r ->> 'creditor_id', r ->> 'status', nullif(r ->> 'note', ''));
    end if;
  end loop;

  -- Turnos: eliminar y luego insertar/actualizar (el disparador bloquea cualquier día pasado)
  delete from public.shifts
   where date in (select d::date from jsonb_array_elements_text(coalesce(p_payload -> 'delete_dates', '[]'::jsonb)) d);

  insert into public.shifts (date, slot_id, assignee_id, original_id, performed_by, status, kind, reason,
                             absence_id, generates_comp, settles_comp, morning_by, updated_at)
  select x.date, x.slot_id, x.assignee_id, x.original_id, x.performed_by, x.status, x.kind, nullif(x.reason, ''),
         x.absence_id, x.generates_comp, x.settles_comp, x.morning_by, now()
    from jsonb_to_recordset(coalesce(p_payload -> 'shifts', '[]'::jsonb)) as x(
           date date, slot_id text, assignee_id text, original_id text, performed_by text, status text,
           kind text, reason text, absence_id uuid, generates_comp uuid, settles_comp uuid, morning_by text)
  on conflict (date) do update set
    slot_id = excluded.slot_id, assignee_id = excluded.assignee_id, original_id = excluded.original_id,
    performed_by = excluded.performed_by, status = excluded.status, kind = excluded.kind,
    reason = excluded.reason, absence_id = excluded.absence_id,
    generates_comp = excluded.generates_comp, settles_comp = excluded.settles_comp,
    morning_by = excluded.morning_by, updated_at = now();

  -- Invariante 1: calendario continuo, sin huecos
  if exists (select 1 from public.shifts)
     and (select count(*) from public.shifts) <> (select max(date) - min(date) + 1 from public.shifts) then
    raise exception 'CALENDAR_GAP: el calendario quedaría con huecos';
  end if;

  -- Invariante 2: nadie ausente tiene una tarea pendiente asignada
  if exists (
    select 1
      from public.shifts s
      join public.absences a
        on a.person_id = s.assignee_id and not a.cancelled and s.date between a.start_date and a.end_date
     where s.date >= v_today and s.status = 'scheduled' and s.kind <> 'mom') then
    raise exception 'ABSENT_ASSIGNED: se asignaría una tarea a una persona ausente';
  end if;

  -- Historial (solo se añade)
  if jsonb_typeof(v_event) = 'object' then
    insert into public.change_log (type, summary, reason, event_date, affected, affected_count, actor)
    values (v_event ->> 'type', left(v_event ->> 'summary', 500), left(nullif(v_event ->> 'reason', ''), 500),
            nullif(v_event ->> 'date', '')::date, coalesce(v_event -> 'affected', '[]'::jsonb),
            coalesce((v_event ->> 'affected_count')::int, 0), auth.uid());
  end if;

  update public.app_settings set version = version + 1, updated_at = now() where id
  returning version into v_version;

  return jsonb_build_object('version', v_version);
end $$;


revoke all on function public.apply_change(jsonb) from public, anon, authenticated;
revoke all on function public.get_calendar(text)  from public, anon, authenticated;
grant execute on function public.get_calendar(text) to anon, authenticated;
grant execute on function public.apply_change(jsonb) to authenticated;
