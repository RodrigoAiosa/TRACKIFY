-- Trackify: permissões do colaborador sobre os próprios lançamentos + exclusão segura
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run

-- Schema privado (não exposto pela API) para funções auxiliares
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Helper anti-recursão: o usuário logado é gestor/admin?
create or replace function private.is_gestor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.perfis p
    where p.id = auth.uid() and p.role in ('gestor', 'admin')
  );
$$;
revoke all on function private.is_gestor() from public, anon;
grant execute on function private.is_gestor() to authenticated;

-- ============ PERFIS ============
drop policy if exists "Acesso proprio perfil" on public.perfis;
create policy perfis_select on public.perfis for select to authenticated
  using (id = (select auth.uid()) or private.is_gestor());
create policy perfis_update_proprio on public.perfis for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- colaborador só pode editar dados pessoais (nunca role, gestor_id, etc.)
revoke insert, update, delete on public.perfis from anon, authenticated;
grant update (nome_completo, sexo, celular) on public.perfis to authenticated;

-- ============ APONTAMENTOS_PONTO ============
drop policy if exists "Acesso proprio ponto" on public.apontamentos_ponto;
create policy ponto_select on public.apontamentos_ponto for select to authenticated
  using (usuario_id = (select auth.uid()) or private.is_gestor());
create policy ponto_insert on public.apontamentos_ponto for insert to authenticated
  with check (usuario_id = (select auth.uid()));
create policy ponto_update_proprio on public.apontamentos_ponto for update to authenticated
  using (usuario_id = (select auth.uid()) and coalesce(registro_travado, false) = false)
  with check (usuario_id = (select auth.uid()));
create policy ponto_update_gestor on public.apontamentos_ponto for update to authenticated
  using (private.is_gestor()) with check (private.is_gestor());
create policy ponto_delete_proprio on public.apontamentos_ponto for delete to authenticated
  using (usuario_id = (select auth.uid()) and coalesce(registro_travado, false) = false);

-- ============ APONTAMENTOS_ATIVIDADES ============
drop policy if exists "Acesso proprias atividades" on public.apontamentos_atividades;
create policy atividades_select on public.apontamentos_atividades for select to authenticated
  using (usuario_id = (select auth.uid()) or gestor_id = (select auth.uid()) or private.is_gestor());
create policy atividades_insert on public.apontamentos_atividades for insert to authenticated
  with check (
    usuario_id = (select auth.uid())
    and (ponto_id is null or exists (
      select 1 from public.apontamentos_ponto p
      where p.id = ponto_id and p.usuario_id = (select auth.uid())))
  );
create policy atividades_update_proprio on public.apontamentos_atividades for update to authenticated
  using (usuario_id = (select auth.uid())
         and coalesce(registro_travado, false) = false
         and status_aprovacao is not distinct from 'Pendente')
  with check (usuario_id = (select auth.uid()));
create policy atividades_update_gestor on public.apontamentos_atividades for update to authenticated
  using (gestor_id = (select auth.uid()) or private.is_gestor())
  with check (gestor_id = (select auth.uid()) or private.is_gestor());
create policy atividades_delete_proprio on public.apontamentos_atividades for delete to authenticated
  using (usuario_id = (select auth.uid())
         and coalesce(registro_travado, false) = false
         and status_aprovacao is not distinct from 'Pendente');

-- ============ Campos de aprovação: só gestor altera ============
create or replace function private.protege_campos_aprovacao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- service role / SQL editor (sem usuário) e gestores passam direto
  if auth.uid() is null or private.is_gestor() then
    return new;
  end if;

  if tg_table_name = 'apontamentos_ponto' then
    if tg_op = 'INSERT' then
      new.total_aprovado_horas := 0;
      new.registro_travado := false;
    else
      new.total_aprovado_horas := old.total_aprovado_horas;
      new.registro_travado := old.registro_travado;
    end if;
  else
    if tg_op = 'INSERT' then
      new.gestor_id := (select p.gestor_id from public.perfis p where p.id = auth.uid());
      new.status_aprovacao := 'Pendente';
      new.duracao_autorizada_minutos := 0;
      new.duracao_aprovada_minutos := 0;
      new.motivo_nao_aprovação := null;
      new.registro_travado := false;
    else
      new.gestor_id := old.gestor_id;
      new.status_aprovacao := old.status_aprovacao;
      new.duracao_autorizada_minutos := old.duracao_autorizada_minutos;
      new.duracao_aprovada_minutos := old.duracao_aprovada_minutos;
      new.motivo_nao_aprovação := old.motivo_nao_aprovação;
      new.registro_travado := old.registro_travado;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.protege_campos_aprovacao() from public, anon, authenticated;

drop trigger if exists trg_protege_ponto on public.apontamentos_ponto;
create trigger trg_protege_ponto before insert or update on public.apontamentos_ponto
  for each row execute function private.protege_campos_aprovacao();
drop trigger if exists trg_protege_atividades on public.apontamentos_atividades;
create trigger trg_protege_atividades before insert or update on public.apontamentos_atividades
  for each row execute function private.protege_campos_aprovacao();

-- ============ Total de horas das atividades sempre consistente ============
create or replace function private.atualiza_total_atividades()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ponto uuid;
begin
  for v_ponto in
    select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.ponto_id end,
      case when tg_op <> 'DELETE' then new.ponto_id end
    ]) as x where x is not null
  loop
    update public.apontamentos_ponto
       set total_atividades_horas = round(coalesce((
             select sum(a.duracao_realizada_minutos)::numeric / 60
             from public.apontamentos_atividades a where a.ponto_id = v_ponto), 0), 2)
     where id = v_ponto;
  end loop;
  return null;
end;
$$;
revoke all on function private.atualiza_total_atividades() from public, anon, authenticated;

drop trigger if exists trg_atividades_totais on public.apontamentos_atividades;
create trigger trg_atividades_totais after insert or update or delete on public.apontamentos_atividades
  for each row execute function private.atualiza_total_atividades();

-- ============ Excluir um dia inteiro (atômico, respeitando RLS) ============
create or replace function public.excluir_ponto_dia(p_ponto_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    select 1 from public.apontamentos_atividades a
    where a.ponto_id = p_ponto_id
      and (coalesce(a.registro_travado, false) or a.status_aprovacao is distinct from 'Pendente')
  ) then
    raise exception 'Este dia possui atividades já avaliadas pelo gestor e não pode ser excluído.';
  end if;

  delete from public.apontamentos_atividades where ponto_id = p_ponto_id;
  delete from public.apontamentos_ponto where id = p_ponto_id;
  if not found then
    raise exception 'Registro não encontrado ou já travado pelo gestor.';
  end if;
end;
$$;
revoke execute on function public.excluir_ponto_dia(uuid) from public, anon;
grant execute on function public.excluir_ponto_dia(uuid) to authenticated;

-- Índices para as consultas da tela
create index if not exists idx_atividades_ponto_id on public.apontamentos_atividades (ponto_id);
create index if not exists idx_atividades_usuario_data on public.apontamentos_atividades (usuario_id, data);
