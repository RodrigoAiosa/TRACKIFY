-- Trackify: aprovação de horas pela gerência (visibilidade por equipe)
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run
-- Pré-requisito: 20261017_colaborador_rls_e_exclusao_segura.sql já aplicada.

-- ============ Helpers (schema private, não exposto pela API) ============
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.perfis p where p.id = auth.uid() and p.role = 'admin');
$$;
revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- O usuário logado pode avaliar os lançamentos de p_usuario?
-- admin: todos | gestor: só colaboradores vinculados a ele (perfis.gestor_id)
create or replace function private.gestor_da_equipe(p_usuario uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.is_admin()
      or (private.is_gestor()
          and exists (select 1 from public.perfis p
                      where p.id = p_usuario and p.gestor_id = auth.uid()));
$$;
revoke all on function private.gestor_da_equipe(uuid) from public, anon;
grant execute on function private.gestor_da_equipe(uuid) to authenticated;

create index if not exists idx_perfis_gestor_id on public.perfis (gestor_id);

-- ============ Policies: gestor vê/avalia só a própria equipe ============
drop policy if exists perfis_select on public.perfis;
create policy perfis_select on public.perfis for select to authenticated
  using (id = (select auth.uid()) or private.gestor_da_equipe(id));

drop policy if exists ponto_select on public.apontamentos_ponto;
create policy ponto_select on public.apontamentos_ponto for select to authenticated
  using (usuario_id = (select auth.uid()) or private.gestor_da_equipe(usuario_id));

drop policy if exists ponto_update_gestor on public.apontamentos_ponto;
create policy ponto_update_gestor on public.apontamentos_ponto for update to authenticated
  using (usuario_id <> (select auth.uid()) and private.gestor_da_equipe(usuario_id))
  with check (usuario_id <> (select auth.uid()) and private.gestor_da_equipe(usuario_id));

drop policy if exists atividades_select on public.apontamentos_atividades;
create policy atividades_select on public.apontamentos_atividades for select to authenticated
  using (usuario_id = (select auth.uid()) or private.gestor_da_equipe(usuario_id));

drop policy if exists atividades_update_gestor on public.apontamentos_atividades;
create policy atividades_update_gestor on public.apontamentos_atividades for update to authenticated
  using (usuario_id <> (select auth.uid()) and private.gestor_da_equipe(usuario_id))
  with check (usuario_id <> (select auth.uid()) and private.gestor_da_equipe(usuario_id));

-- Colaborador não lança atividade em dia já travado pelo gestor
drop policy if exists atividades_insert on public.apontamentos_atividades;
create policy atividades_insert on public.apontamentos_atividades for insert to authenticated
  with check (
    usuario_id = (select auth.uid())
    and (ponto_id is null or exists (
      select 1 from public.apontamentos_ponto p
      where p.id = ponto_id
        and p.usuario_id = (select auth.uid())
        and coalesce(p.registro_travado, false) = false))
  );

-- ============ Trigger: quem pode alterar o quê ============
-- Dono do lançamento (inclusive gestor/admin lançando as próprias horas): não mexe em campos de aprovação.
-- Avaliador (gestor da equipe/admin) em lançamento de terceiros: altera SOMENTE campos de avaliação, com validação.
create or replace function private.protege_campos_aprovacao()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_dono uuid;
begin
  -- service role / SQL editor (sem usuário logado)
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_dono := old.usuario_id;
  else
    v_dono := new.usuario_id;
  end if;

  -- ---------- Dono do lançamento ----------
  if v_dono = auth.uid() then
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
  end if;

  -- ---------- Avaliador (lançamento de terceiros) ----------
  if tg_op <> 'UPDATE' then
    return new;  -- INSERT/DELETE de terceiros já é barrado pelo RLS
  end if;

  if tg_table_name = 'apontamentos_ponto' then
    -- só total_aprovado_horas e registro_travado podem mudar
    new.usuario_id := old.usuario_id;
    new.data := old.data;
    new.modalidade := old.modalidade;
    new.entrada_1 := old.entrada_1;  new.saida_1 := old.saida_1;
    new.entrada_2 := old.entrada_2;  new.saida_2 := old.saida_2;
    new.entrada_3 := old.entrada_3;  new.saida_3 := old.saida_3;
    new.total_diario_horas := old.total_diario_horas;
    new.total_atividades_horas := old.total_atividades_horas;
    return new;
  end if;

  -- atividades: só os campos de avaliação podem mudar
  new.ponto_id := old.ponto_id;
  new.usuario_id := old.usuario_id;
  new.gestor_id := old.gestor_id;
  new.data := old.data;
  new.projeto_id := old.projeto_id;
  new.tipo_atividade_id := old.tipo_atividade_id;
  new.descricao_atividade := old.descricao_atividade;
  new.prioridade_dia := old.prioridade_dia;
  new.data_prevista := old.data_prevista;
  new.duracao_prevista_minutos := old.duracao_prevista_minutos;
  new.duracao_realizada_minutos := old.duracao_realizada_minutos;
  new.intercorrencias := old.intercorrencias;
  new.duracao_autorizada_minutos := old.duracao_autorizada_minutos;

  if new.status_aprovacao = 'Pendente' then
    new.duracao_aprovada_minutos := 0;
    new.motivo_nao_aprovação := null;
    new.registro_travado := false;
  elsif new.status_aprovacao = 'Aprovado Integral' then
    new.duracao_aprovada_minutos := new.duracao_realizada_minutos;
    new.motivo_nao_aprovação := null;
    new.registro_travado := true;
  elsif new.status_aprovacao = 'Aprovado Parcial' then
    if coalesce(new.duracao_aprovada_minutos, 0) <= 0
       or new.duracao_aprovada_minutos >= new.duracao_realizada_minutos then
      raise exception 'Na aprovação parcial, informe um tempo maior que zero e menor que o realizado (% min).',
        new.duracao_realizada_minutos;
    end if;
    new.registro_travado := true;
  elsif new.status_aprovacao = 'Glosado/Rejeitado' then
    if nullif(btrim(coalesce(new.motivo_nao_aprovação, '')), '') is null then
      raise exception 'Informe o motivo da rejeição.';
    end if;
    new.duracao_aprovada_minutos := 0;
    new.registro_travado := true;
  end if;

  return new;
end;
$$;
revoke all on function private.protege_campos_aprovacao() from public, anon, authenticated;

-- ============ Funções de aprovação (security invoker: valem as regras acima) ============
create or replace function public.avaliar_atividade(
  p_atividade_id uuid,
  p_status text,
  p_minutos_aprovados integer default null,
  p_motivo text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ponto uuid;
begin
  if not private.is_gestor() then
    raise exception 'Apenas gestores podem avaliar atividades.';
  end if;
  if p_status not in ('Pendente', 'Aprovado Integral', 'Aprovado Parcial', 'Glosado/Rejeitado') then
    raise exception 'Status de avaliação inválido.';
  end if;

  update public.apontamentos_atividades
     set status_aprovacao = p_status,
         duracao_aprovada_minutos = coalesce(p_minutos_aprovados, 0),
         motivo_nao_aprovação = nullif(btrim(coalesce(p_motivo, '')), '')
   where id = p_atividade_id
     and usuario_id <> auth.uid()
  returning ponto_id into v_ponto;

  if not found then
    raise exception 'Atividade não encontrada ou sem permissão para avaliar.';
  end if;

  -- trava o dia quando todas as atividades foram avaliadas e atualiza o total aprovado
  if v_ponto is not null then
    update public.apontamentos_ponto p
       set registro_travado = (s.n > 0 and s.pendentes = 0),
           total_aprovado_horas = round(s.aprovado / 60.0, 2)
      from (
        select count(*) as n,
               count(*) filter (where a.status_aprovacao is not distinct from 'Pendente') as pendentes,
               coalesce(sum(a.duracao_aprovada_minutos), 0) as aprovado
          from public.apontamentos_atividades a
         where a.ponto_id = v_ponto
      ) s
     where p.id = v_ponto;
  end if;
end;
$$;
revoke execute on function public.avaliar_atividade(uuid, text, integer, text) from public, anon;
grant execute on function public.avaliar_atividade(uuid, text, integer, text) to authenticated;

create or replace function public.aprovar_dia(p_ponto_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select a.id from public.apontamentos_atividades a
     where a.ponto_id = p_ponto_id
       and a.status_aprovacao is not distinct from 'Pendente'
  loop
    perform public.avaliar_atividade(r.id, 'Aprovado Integral');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.aprovar_dia(uuid) from public, anon;
grant execute on function public.aprovar_dia(uuid) to authenticated;
