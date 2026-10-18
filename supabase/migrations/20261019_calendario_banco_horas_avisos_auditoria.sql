-- Trackify: calendário (feriados e ausências), jornada e banco de horas, avisos e trilha de auditoria
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run (pode rodar mais de uma vez sem problema)
-- Pré-requisito: 20261018_cadastros_edicao_fechamento.sql já aplicada.
--
--  5) feriados + ausencias (férias, atestado, folga): o cálculo de "dias úteis" passa a descontá-los
--     e a ignorar dias anteriores à criação da conta da pessoa.
--  6) perfis.jornada_diaria_minutos + saldo_horas() + rel_banco_horas(): esperado x trabalhado.
--  7) notificacoes: avisos dentro do sistema (sino), gerados por gatilhos e por lembretes.
--  8) auditoria: registro automático, imutável, de quem fez o quê e quando.

-- ============================================================
-- Utilitário: carimba o autor do registro
-- ============================================================
create or replace function private.carimba_autor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.criado_por := auth.uid();
  end if;
  return new;
end;
$$;
revoke all on function private.carimba_autor() from public, anon, authenticated;

-- ============================================================
-- 5) Feriados e ausências
-- ============================================================
create table if not exists public.feriados (
  data       date primary key,
  descricao  text not null check (char_length(btrim(descricao)) between 2 and 100),
  criado_por uuid references public.perfis(id) on delete set null,
  criado_em  timestamptz not null default now()
);
alter table public.feriados enable row level security;
drop policy if exists feriados_select on public.feriados;
create policy feriados_select on public.feriados for select to authenticated using (true);
drop policy if exists feriados_admin on public.feriados;
create policy feriados_admin on public.feriados for all to authenticated
  using (private.is_admin()) with check (private.is_admin());
revoke all on public.feriados from anon, authenticated;
grant select, insert, update, delete on public.feriados to authenticated;
drop trigger if exists trg_feriados_autor on public.feriados;
create trigger trg_feriados_autor before insert on public.feriados
  for each row execute function private.carimba_autor();

create table if not exists public.ausencias (
  id          bigint generated always as identity primary key,
  usuario_id  uuid not null references public.perfis(id) on delete cascade,
  tipo        text not null check (tipo in ('Férias', 'Atestado', 'Folga', 'Outro')),
  data_inicio date not null,
  data_fim    date not null,
  observacao  text check (observacao is null or char_length(observacao) <= 300),
  criado_por  uuid references public.perfis(id) on delete set null,
  criado_em   timestamptz not null default now(),
  check (data_fim >= data_inicio),
  check (data_fim - data_inicio <= 400)
);
create index if not exists idx_ausencias_usuario on public.ausencias (usuario_id, data_inicio, data_fim);
alter table public.ausencias enable row level security;
-- vê: a própria pessoa, o gerente da equipe e o ADM. Cadastra/remove: gerente da equipe e ADM.
drop policy if exists ausencias_select on public.ausencias;
create policy ausencias_select on public.ausencias for select to authenticated
  using (usuario_id = (select auth.uid()) or private.gestor_da_equipe(usuario_id));
drop policy if exists ausencias_insert on public.ausencias;
create policy ausencias_insert on public.ausencias for insert to authenticated
  with check (private.gestor_da_equipe(usuario_id));
drop policy if exists ausencias_update on public.ausencias;
create policy ausencias_update on public.ausencias for update to authenticated
  using (private.gestor_da_equipe(usuario_id)) with check (private.gestor_da_equipe(usuario_id));
drop policy if exists ausencias_delete on public.ausencias;
create policy ausencias_delete on public.ausencias for delete to authenticated
  using (private.gestor_da_equipe(usuario_id));
revoke all on public.ausencias from anon, authenticated;
grant select, insert, update, delete on public.ausencias to authenticated;
drop trigger if exists trg_ausencias_autor on public.ausencias;
create trigger trg_ausencias_autor before insert on public.ausencias
  for each row execute function private.carimba_autor();

-- Dias em que a pessoa deveria ter lançado: seg-sex, fora feriados e ausências, a partir da criação da conta
create or replace function public.dias_esperados(p_usuario uuid, p_de date, p_ate date)
returns setof date
language sql
stable
security invoker
set search_path = public
as $$
  select d::date
    from public.perfis u
   cross join generate_series(p_de, least(p_ate, p_de + 800), interval '1 day') d
   where u.id = p_usuario
     and extract(isodow from d) < 6
     and d::date >= coalesce((u.criado_em at time zone 'America/Sao_Paulo')::date, date '1900-01-01')
     and not exists (select 1 from public.feriados f where f.data = d::date)
     and not exists (select 1 from public.ausencias a
                      where a.usuario_id = p_usuario and d::date between a.data_inicio and a.data_fim)
   order by 1;
$$;
revoke all on function public.dias_esperados(uuid, date, date) from public, anon;
grant execute on function public.dias_esperados(uuid, date, date) to authenticated;

-- ============================================================
-- 6) Jornada contratada e banco de horas
-- ============================================================
alter table public.perfis add column if not exists jornada_diaria_minutos integer not null default 480;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'perfis_jornada_check') then
    alter table public.perfis add constraint perfis_jornada_check
      check (jornada_diaria_minutos between 0 and 1440);
  end if;
end $$;

-- A edição do cadastro agora inclui a jornada diária (a versão antiga é substituída)
drop function if exists public.admin_editar_perfil(uuid, text, text, text, boolean);
create or replace function public.admin_editar_perfil(
  p_usuario uuid, p_nome text, p_celular text, p_sexo text, p_fim_semana boolean,
  p_jornada_min integer default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome text := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g');
begin
  if not private.is_admin() then
    raise exception 'Apenas o administrador pode editar cadastros.';
  end if;
  if char_length(v_nome) < 3 or char_length(v_nome) > 120 then
    raise exception 'Informe o nome completo (3 a 120 caracteres).';
  end if;
  if p_jornada_min is not null and (p_jornada_min < 0 or p_jornada_min > 1440) then
    raise exception 'A jornada diária deve ficar entre 0 e 24 horas.';
  end if;
  if not exists (select 1 from public.perfis where id = p_usuario) then
    raise exception 'Usuário não encontrado.';
  end if;
  update public.perfis
     set nome_completo = v_nome,
         celular = nullif(btrim(coalesce(p_celular, '')), ''),
         sexo = nullif(btrim(coalesce(p_sexo, '')), ''),
         permite_fim_semana = coalesce(p_fim_semana, false),
         jornada_diaria_minutos = coalesce(p_jornada_min, jornada_diaria_minutos),
         atualizado_em = now()
   where id = p_usuario;
end;
$$;
revoke all on function public.admin_editar_perfil(uuid, text, text, text, boolean, integer) from public, anon;
grant execute on function public.admin_editar_perfil(uuid, text, text, text, boolean, integer) to authenticated;

-- Saldo no período: trabalhado (ponto) - esperado (dias esperados x jornada).
-- Conta só até ontem, para o dia corrente (ainda em andamento) não gerar saldo negativo.
create or replace function public.saldo_horas(p_usuario uuid, p_de date, p_ate date)
returns table (dias_esperados integer, esperado_min integer, trabalhado_min integer, saldo_min integer)
language sql
stable
security invoker
set search_path = public
as $$
  with lim as (
    select least(p_ate, (now() at time zone 'America/Sao_Paulo')::date - 1) as ate
  ), j as (
    select jornada_diaria_minutos as jm from public.perfis where id = p_usuario
  ), e as (
    select count(*)::int as n from public.dias_esperados(p_usuario, p_de, (select ate from lim))
  ), t as (
    select coalesce(round(sum(total_diario_horas) * 60), 0)::int as m
      from public.apontamentos_ponto
     where usuario_id = p_usuario and data >= p_de and data <= (select ate from lim)
  )
  select e.n, e.n * coalesce(j.jm, 480), t.m, t.m - e.n * coalesce(j.jm, 480)
    from e, t left join j on true;
$$;
revoke all on function public.saldo_horas(uuid, date, date) from public, anon;
grant execute on function public.saldo_horas(uuid, date, date) to authenticated;

create or replace function public.rel_banco_horas(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (usuario_id uuid, gestor_id uuid, colaborador text, gerente text, jornada_horas numeric,
               dias_esperados integer, esperado_horas numeric, trabalhado_horas numeric, saldo_horas numeric)
language sql stable security invoker set search_path = public as $$
  select u.id, u.gestor_id, u.nome_completo, coalesce(g.nome_completo, 'Sem gerente'),
         round(u.jornada_diaria_minutos / 60.0, 2),
         s.dias_esperados, round(s.esperado_min / 60.0, 2), round(s.trabalhado_min / 60.0, 2), round(s.saldo_min / 60.0, 2)
    from public.perfis u
    left join public.perfis g on g.id = u.gestor_id
    cross join lateral public.saldo_horas(u.id, p_de, p_ate) s
   where u.role <> 'admin' and u.ativo
   order by s.saldo_min, u.nome_completo;
$$;
revoke all on function public.rel_banco_horas(date, date) from public, anon;
grant execute on function public.rel_banco_horas(date, date) to authenticated;

-- Dias úteis sem lançamento: agora desconta feriados, ausências e dias anteriores à conta; ignora inativos
create or replace function public.rel_dias_sem_lancamento(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (colaborador text, gerente text, dias_uteis bigint, dias_lancados bigint, dias_sem_lancamento bigint)
language sql stable security invoker set search_path = public as $$
  select u.nome_completo, coalesce(g.nome_completo, 'Sem gerente'),
         x.uteis, x.lancados, x.uteis - x.lancados
    from public.perfis u
    left join public.perfis g on g.id = u.gestor_id
    cross join lateral (
      select count(*) as uteis,
             count(*) filter (where exists (
               select 1 from public.apontamentos_ponto p where p.usuario_id = u.id and p.data = d)) as lancados
        from public.dias_esperados(u.id, p_de, least(p_ate, (now() at time zone 'America/Sao_Paulo')::date)) d) x
   where u.role <> 'admin' and u.ativo
   order by 5 desc, 1;
$$;

-- ============================================================
-- 7) Avisos (notificações)
-- ============================================================
create table if not exists public.notificacoes (
  id               bigint generated always as identity primary key,
  usuario_id       uuid not null references public.perfis(id) on delete cascade,
  tipo             text not null,
  titulo           text not null,
  mensagem         text not null,
  chave            text,
  contagem         integer not null default 1,
  criado_em        timestamptz not null default now(),
  lida_em          timestamptz,
  email_enviado_em timestamptz
);
-- enquanto um aviso da mesma chave não foi lido, novos eventos atualizam o mesmo aviso (sem encher a caixa)
create unique index if not exists uq_notificacoes_abertas
  on public.notificacoes (usuario_id, chave) where lida_em is null and chave is not null;
create index if not exists idx_notificacoes_usuario on public.notificacoes (usuario_id, criado_em desc);
create index if not exists idx_notificacoes_email on public.notificacoes (criado_em) where email_enviado_em is null and lida_em is null;
alter table public.notificacoes enable row level security;
drop policy if exists notificacoes_select on public.notificacoes;
create policy notificacoes_select on public.notificacoes for select to authenticated
  using (usuario_id = (select auth.uid()));
revoke all on public.notificacoes from anon, authenticated;
grant select on public.notificacoes to authenticated;

create or replace function private.notificar(p_usuario uuid, p_tipo text, p_titulo text, p_mensagem text, p_chave text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notificacoes (usuario_id, tipo, titulo, mensagem, chave)
  values (p_usuario, p_tipo, p_titulo, p_mensagem, p_chave)
  on conflict (usuario_id, chave) where lida_em is null and chave is not null
  do update set titulo = excluded.titulo, mensagem = excluded.mensagem,
                contagem = public.notificacoes.contagem + 1, criado_em = now(), email_enviado_em = null;
end;
$$;
revoke all on function private.notificar(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.marcar_notificacoes_lidas(p_ids bigint[] default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notificacoes
     set lida_em = now()
   where usuario_id = auth.uid() and lida_em is null
     and (p_ids is null or id = any (p_ids));
$$;
revoke all on function public.marcar_notificacoes_lidas(bigint[]) from public, anon;
grant execute on function public.marcar_notificacoes_lidas(bigint[]) to authenticated;

-- Aviso ao colaborador quando a atividade é avaliada por outra pessoa
create or replace function private.avisa_avaliacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desc text := left(new.descricao_atividade, 60);
  v_dia text := to_char(new.data, 'DD/MM/YYYY');
begin
  if new.status_aprovacao is not distinct from old.status_aprovacao
     or new.status_aprovacao is not distinct from 'Pendente'
     or auth.uid() is not distinct from new.usuario_id then
    return null;
  end if;

  if new.status_aprovacao ilike '%rejeit%' or new.status_aprovacao ilike '%glosad%' then
    perform private.notificar(new.usuario_id, 'rejeicao', 'Atividade rejeitada',
      format('“%s” (%s) foi rejeitada. Motivo: %s', v_desc, v_dia, coalesce(nullif(new."motivo_nao_aprovação", ''), 'não informado')),
      'rej-' || new.id);
  elsif new.status_aprovacao ilike '%parcial%' then
    perform private.notificar(new.usuario_id, 'ajuste', 'Atividade ajustada',
      format('“%s” (%s) foi aprovada parcialmente: %s min aprovados de %s min informados.%s',
             v_desc, v_dia, new.duracao_aprovada_minutos, new.duracao_realizada_minutos,
             case when nullif(new."motivo_nao_aprovação", '') is not null then ' Observação: ' || new."motivo_nao_aprovação" else '' end),
      'aj-' || new.id);
  else
    perform private.notificar(new.usuario_id, 'aprovacao', 'Horas aprovadas',
      format('Atividades de %s foram aprovadas. Veja o resultado em “Meus lançamentos”.', v_dia),
      'aprov-' || new.data);
  end if;
  return null;
end;
$$;
revoke all on function private.avisa_avaliacao() from public, anon, authenticated;
drop trigger if exists trg_avisa_avaliacao on public.apontamentos_atividades;
create trigger trg_avisa_avaliacao after update on public.apontamentos_atividades
  for each row execute function private.avisa_avaliacao();

-- Lembretes: colaborador que esqueceu de lançar; gerente com pendências paradas; ADM com pendências sem gerente.
-- p_usuario = null processa todos (uso agendado); com valor, só aquela pessoa (uso ao abrir o sistema).
create or replace function private.gerar_lembretes(p_usuario uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_total integer := 0;
  r record;
  v_dias text;
  v_n integer;
begin
  -- 1) esqueceu de lançar (últimos 7 dias, até ontem)
  for r in select id from public.perfis where role <> 'admin' and ativo and (p_usuario is null or id = p_usuario) loop
    select string_agg(to_char(d, 'DD/MM'), ', ' order by d), count(*)
      into v_dias, v_n
      from public.dias_esperados(r.id, v_hoje - 7, v_hoje - 1) d
     where not exists (select 1 from public.apontamentos_ponto p where p.usuario_id = r.id and p.data = d);
    if v_n > 0 and not exists (select 1 from public.notificacoes n
                                where n.usuario_id = r.id and n.chave = 'esqueceu' and n.criado_em > now() - interval '20 hours') then
      perform private.notificar(r.id, 'lembrete', 'Você esqueceu de lançar horas',
        format('Faltam lançamentos em: %s. Abra “Lançamento de Ponto & Atividades” para registrar.', v_dias), 'esqueceu');
      v_total := v_total + 1;
    end if;
  end loop;

  -- 2) gerentes com pendências paradas há mais de 3 dias
  for r in select id from public.perfis where role = 'gestor' and ativo and (p_usuario is null or id = p_usuario) loop
    select count(*) into v_n from public.apontamentos_atividades a
     where a.gestor_id = r.id and a.status_aprovacao is not distinct from 'Pendente' and a.data <= v_hoje - 3;
    if v_n > 0 and not exists (select 1 from public.notificacoes n
                                where n.usuario_id = r.id and n.chave = 'pendencias' and n.criado_em > now() - interval '20 hours') then
      perform private.notificar(r.id, 'pendencia', 'Atividades aguardando sua avaliação',
        format('%s atividade(s) da sua equipe estão pendentes há mais de 3 dias.', v_n), 'pendencias');
      v_total := v_total + 1;
    end if;
  end loop;

  -- 3) ADM: pendências de pessoas sem gerente
  select count(*) into v_n from public.apontamentos_atividades a
   where a.gestor_id is null and a.status_aprovacao is not distinct from 'Pendente' and a.data <= v_hoje - 3;
  if v_n > 0 then
    for r in select id from public.perfis where role = 'admin' and ativo and (p_usuario is null or id = p_usuario) loop
      if not exists (select 1 from public.notificacoes n
                      where n.usuario_id = r.id and n.chave = 'sem-gerente' and n.criado_em > now() - interval '20 hours') then
        perform private.notificar(r.id, 'pendencia', 'Atividades sem gerente definido',
          format('%s atividade(s) pendentes há mais de 3 dias são de pessoas sem gerente. Defina o gerente na aba Equipe.', v_n), 'sem-gerente');
        v_total := v_total + 1;
      end if;
    end loop;
  end if;
  return v_total;
end;
$$;
revoke all on function private.gerar_lembretes(uuid) from public, anon, authenticated;

create or replace function public.gerar_meus_lembretes()
returns void
language sql
security definer
set search_path = public
as $$
  select private.gerar_lembretes(auth.uid()) where auth.uid() is not null;
$$;
revoke all on function public.gerar_meus_lembretes() from public, anon;
grant execute on function public.gerar_meus_lembretes() to authenticated;

-- ============================================================
-- 8) Trilha de auditoria
-- ============================================================
create table if not exists public.auditoria (
  id              bigint generated always as identity primary key,
  em              timestamptz not null default now(),
  ator_id         uuid,
  ator_nome       text,
  acao            text not null,
  tabela          text not null,
  registro_id     text,
  alvo_usuario_id uuid,
  antes           jsonb,
  depois          jsonb
);
create index if not exists idx_auditoria_registro on public.auditoria (tabela, registro_id);
create index if not exists idx_auditoria_alvo on public.auditoria (alvo_usuario_id, em desc);
create index if not exists idx_auditoria_em on public.auditoria (em desc);
alter table public.auditoria enable row level security;
-- vê: ADM (tudo), gerente (a própria equipe) e cada pessoa (o que foi feito nos próprios registros)
drop policy if exists auditoria_select on public.auditoria;
create policy auditoria_select on public.auditoria for select to authenticated
  using (private.is_admin()
         or alvo_usuario_id = (select auth.uid())
         or private.gestor_da_equipe(alvo_usuario_id));
-- ninguém altera nem apaga: só leitura para os usuários, e gravação só pelos gatilhos
revoke all on public.auditoria from anon, authenticated;
grant select on public.auditoria to authenticated;

create or replace function private.audita()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_j jsonb := coalesce(v_new, v_old);
  v_antes jsonb;
  v_depois jsonb;
  v_chave text;
  v_ignorar text[] := array['atualizado_em', 'total_atividades_horas', 'total_aprovado_horas', 'criado_em'];
begin
  if tg_op = 'UPDATE' then
    v_antes := '{}'::jsonb;
    v_depois := '{}'::jsonb;
    for v_chave in select jsonb_object_keys(v_new) loop
      if v_chave = any (v_ignorar) then continue; end if;
      if (v_new -> v_chave) is distinct from (v_old -> v_chave) then
        v_antes := v_antes || jsonb_build_object(v_chave, v_old -> v_chave);
        v_depois := v_depois || jsonb_build_object(v_chave, v_new -> v_chave);
      end if;
    end loop;
    if v_depois = '{}'::jsonb then
      return null;   -- só mudou campo técnico (totais, carimbo de data)
    end if;
  elsif tg_op = 'INSERT' then
    v_depois := v_new;
  else
    v_antes := v_old;
  end if;

  insert into public.auditoria (ator_id, ator_nome, acao, tabela, registro_id, alvo_usuario_id, antes, depois)
  values (
    auth.uid(),
    (select p.nome_completo from public.perfis p where p.id = auth.uid()),
    lower(tg_op), tg_table_name,
    coalesce(v_j ->> 'id', v_j ->> 'mes', v_j ->> 'data'),
    case tg_table_name when 'perfis' then (v_j ->> 'id')::uuid else (v_j ->> 'usuario_id')::uuid end,
    v_antes, v_depois);
  return null;
end;
$$;
revoke all on function private.audita() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['apontamentos_atividades', 'apontamentos_ponto', 'perfis', 'projetos',
                           'fechamentos_mes', 'feriados', 'ausencias'] loop
    execute format('drop trigger if exists trg_audita on public.%I', t);
    execute format('create trigger trg_audita after insert or update or delete on public.%I
                    for each row execute function private.audita()', t);
  end loop;
end $$;
