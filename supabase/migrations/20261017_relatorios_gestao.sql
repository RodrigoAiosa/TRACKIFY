-- Trackify: relatórios de gestão em SQL (os mesmos 14 da aba "Relatórios")
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run
-- Pré-requisitos: 20261017_aprovacao_gerencia.sql (e as anteriores).
--
-- Como usar (SQL Editor, Power BI, Excel, qualquer cliente SQL):
--   select * from public.rel_resumo('2026-10-01', '2026-10-31');
--   select * from public.rel_horas_por_colaborador('2026-10-01', '2026-10-31');
--   (sem parâmetros = do dia 1 do mês atual até hoje)
--
-- Segurança: tudo é "security invoker", então vale o RLS de quem consulta:
--   ADM enxerga todas as equipes, gerente só a própria equipe, colaborador só os próprios dados.
--   (No SQL Editor você consulta como dono do banco e enxerga tudo.)
-- Horas são decimais (1,50 = 1h30). Percentuais de 0 a 100.

-- ============================================================
-- Views base (uma linha por atividade / por dia de ponto)
-- ============================================================
create or replace view public.vw_rel_atividades
with (security_invoker = true) as
select
  a.id,
  a.data,
  a.usuario_id,
  u.nome_completo                                   as colaborador,
  u.gestor_id,
  coalesce(g.nome_completo, 'Sem gerente')          as gerente,
  a.projeto_id,
  coalesce(pr.nome_projeto, 'Sem projeto')          as projeto,
  a.tipo_atividade_id,
  coalesce(t.nome, 'Sem tipo')                      as tipo_atividade,
  a.descricao_atividade,
  coalesce(a.status_aprovacao, 'Pendente')          as status,
  coalesce(a.duracao_prevista_minutos, 0)           as prevista_min,
  coalesce(a.duracao_realizada_minutos, 0)          as realizada_min,
  coalesce(a.duracao_aprovada_minutos, 0)           as aprovada_min,
  a.intercorrencias,
  a."motivo_nao_aprovação"                          as motivo
from public.apontamentos_atividades a
join public.perfis u            on u.id = a.usuario_id
left join public.perfis g       on g.id = u.gestor_id
left join public.projetos pr    on pr.id = a.projeto_id
left join public.tipos_atividade t on t.id = a.tipo_atividade_id;

create or replace view public.vw_rel_dias
with (security_invoker = true) as
select
  p.id,
  p.data,
  p.usuario_id,
  u.nome_completo                                   as colaborador,
  u.gestor_id,
  coalesce(g.nome_completo, 'Sem gerente')          as gerente,
  coalesce(p.modalidade, 'Não informada')           as modalidade,
  round(coalesce(p.total_diario_horas, 0) * 60)::int as trabalhada_min
from public.apontamentos_ponto p
join public.perfis u      on u.id = p.usuario_id
left join public.perfis g on g.id = u.gestor_id;

-- ============================================================
-- Funções de relatório (parâmetros: período)
-- ============================================================

-- 1) Resumo com indicadores
create or replace function public.rel_resumo(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (
  colaboradores_com_lancamento bigint, colaboradores_total bigint, dias_lancados bigint,
  horas_trabalhadas numeric, horas_atividades numeric, horas_aprovadas numeric, aprovacao_pct numeric,
  atividades_pendentes bigint, horas_pendentes numeric, atividades_rejeitadas bigint)
language sql stable security invoker set search_path = public as $$
  with d as (select * from public.vw_rel_dias where data between p_de and p_ate),
       a as (select * from public.vw_rel_atividades where data between p_de and p_ate)
  select
    (select count(distinct usuario_id) from d),
    (select count(*) from public.perfis where role <> 'admin'),
    (select count(*) from d),
    round((select coalesce(sum(trabalhada_min), 0) from d) / 60.0, 2),
    round((select coalesce(sum(realizada_min), 0) from a) / 60.0, 2),
    round((select coalesce(sum(aprovada_min), 0) from a) / 60.0, 2),
    round(100.0 * (select coalesce(sum(aprovada_min), 0) from a)
          / nullif((select sum(realizada_min) from a where status <> 'Pendente'), 0), 1),
    (select count(*) from a where status = 'Pendente'),
    round((select coalesce(sum(realizada_min), 0) from a where status = 'Pendente') / 60.0, 2),
    (select count(*) from a where status = 'Glosado/Rejeitado');
$$;

-- 2) Horas por colaborador
create or replace function public.rel_horas_por_colaborador(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (
  colaborador text, gerente text, dias_lancados bigint, horas_trabalhadas numeric, horas_atividades numeric,
  aderencia_pct numeric, horas_aprovadas numeric, aprovacao_pct numeric, atividades_pendentes bigint, horas_pendentes numeric)
language sql stable security invoker set search_path = public as $$
  with d as (
    select usuario_id, count(*) dias, sum(trabalhada_min) trab
      from public.vw_rel_dias where data between p_de and p_ate group by usuario_id),
  a as (
    select usuario_id,
           sum(realizada_min) real, sum(aprovada_min) apr,
           sum(realizada_min) filter (where status <> 'Pendente') aval,
           count(*) filter (where status = 'Pendente') pend,
           coalesce(sum(realizada_min) filter (where status = 'Pendente'), 0) pend_min
      from public.vw_rel_atividades where data between p_de and p_ate group by usuario_id)
  select u.nome_completo, coalesce(g.nome_completo, 'Sem gerente'),
         coalesce(d.dias, 0),
         round(coalesce(d.trab, 0) / 60.0, 2),
         round(coalesce(a.real, 0) / 60.0, 2),
         round(100.0 * a.real / nullif(d.trab, 0), 1),
         round(coalesce(a.apr, 0) / 60.0, 2),
         round(100.0 * a.apr / nullif(a.aval, 0), 1),
         coalesce(a.pend, 0),
         round(coalesce(a.pend_min, 0) / 60.0, 2)
    from public.perfis u
    left join public.perfis g on g.id = u.gestor_id
    left join d on d.usuario_id = u.id
    left join a on a.usuario_id = u.id
   where u.role <> 'admin'
   order by 4 desc nulls last, 1;
$$;

-- 3) Horas por gerente (equipe)
create or replace function public.rel_horas_por_gerente(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (
  gerente text, colaboradores bigint, dias_lancados bigint, horas_trabalhadas numeric, horas_atividades numeric,
  horas_aprovadas numeric, aprovacao_pct numeric, atividades_pendentes bigint)
language sql stable security invoker set search_path = public as $$
  with c as (select * from public.rel_horas_por_colaborador(p_de, p_ate)),
       av as (
         select gerente, sum(realizada_min) filter (where status <> 'Pendente') aval, sum(aprovada_min) apr
           from public.vw_rel_atividades where data between p_de and p_ate group by gerente)
  select c.gerente, count(*), sum(c.dias_lancados)::bigint, sum(c.horas_trabalhadas), sum(c.horas_atividades),
         sum(c.horas_aprovadas),
         round(100.0 * max(av.apr) / nullif(max(av.aval), 0), 1),
         sum(c.atividades_pendentes)::bigint
    from c left join av on av.gerente = c.gerente
   group by c.gerente
   order by 4 desc, 1;
$$;

-- 4) Horas por projeto
create or replace function public.rel_horas_por_projeto(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (projeto text, atividades bigint, horas_realizadas numeric, pct_do_total numeric, horas_aprovadas numeric, aprovacao_pct numeric)
language sql stable security invoker set search_path = public as $$
  select projeto, count(*), round(sum(realizada_min) / 60.0, 2),
         round(100.0 * sum(realizada_min) / nullif(sum(sum(realizada_min)) over (), 0), 1),
         round(sum(aprovada_min) / 60.0, 2),
         round(100.0 * sum(aprovada_min) / nullif(sum(realizada_min) filter (where status <> 'Pendente'), 0), 1)
    from public.vw_rel_atividades where data between p_de and p_ate
   group by projeto order by 3 desc, 1;
$$;

-- 5) Horas por tipo de atividade
create or replace function public.rel_horas_por_tipo(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (tipo_atividade text, atividades bigint, horas_realizadas numeric, pct_do_total numeric, horas_aprovadas numeric, aprovacao_pct numeric)
language sql stable security invoker set search_path = public as $$
  select tipo_atividade, count(*), round(sum(realizada_min) / 60.0, 2),
         round(100.0 * sum(realizada_min) / nullif(sum(sum(realizada_min)) over (), 0), 1),
         round(sum(aprovada_min) / 60.0, 2),
         round(100.0 * sum(aprovada_min) / nullif(sum(realizada_min) filter (where status <> 'Pendente'), 0), 1)
    from public.vw_rel_atividades where data between p_de and p_ate
   group by tipo_atividade order by 3 desc, 1;
$$;

-- 6) Projeto x colaborador
create or replace function public.rel_projeto_colaborador(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (projeto text, colaborador text, horas_realizadas numeric)
language sql stable security invoker set search_path = public as $$
  select projeto, colaborador, round(sum(realizada_min) / 60.0, 2)
    from public.vw_rel_atividades where data between p_de and p_ate
   group by projeto, colaborador order by 3 desc, 1, 2;
$$;

-- 7) Situação das aprovações (sempre mostra os 4 status)
create or replace function public.rel_situacao_aprovacoes(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (situacao text, atividades bigint, horas_realizadas numeric, horas_aprovadas numeric)
language sql stable security invoker set search_path = public as $$
  select s.situacao, count(a.id), round(coalesce(sum(a.realizada_min), 0) / 60.0, 2), round(coalesce(sum(a.aprovada_min), 0) / 60.0, 2)
    from (values (1, 'Pendente'), (2, 'Aprovado Integral'), (3, 'Aprovado Parcial'), (4, 'Glosado/Rejeitado')) s(ord, situacao)
    left join public.vw_rel_atividades a on a.status = s.situacao and a.data between p_de and p_ate
   group by s.ord, s.situacao order by s.ord;
$$;

-- 8) Previsto x realizado por colaborador (desvio > 0 = gastou mais do que previu)
create or replace function public.rel_previsto_realizado(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (colaborador text, horas_previstas numeric, horas_realizadas numeric, desvio_pct numeric)
language sql stable security invoker set search_path = public as $$
  select colaborador, round(sum(prevista_min) / 60.0, 2), round(sum(realizada_min) / 60.0, 2),
         round(100.0 * (sum(realizada_min) - sum(prevista_min)) / nullif(sum(prevista_min), 0), 1)
    from public.vw_rel_atividades where data between p_de and p_ate
   group by colaborador having sum(prevista_min) > 0 or sum(realizada_min) > 0
   order by 1;
$$;

-- 9) Presencial x remoto
create or replace function public.rel_modalidade(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (modalidade text, dias bigint, horas_trabalhadas numeric, pct_dos_dias numeric)
language sql stable security invoker set search_path = public as $$
  select modalidade, count(*), round(sum(trabalhada_min) / 60.0, 2),
         round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1)
    from public.vw_rel_dias where data between p_de and p_ate
   group by modalidade order by 2 desc, 1;
$$;

-- 10) Evolução diária
create or replace function public.rel_evolucao_diaria(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (data date, horas_trabalhadas numeric, horas_atividades numeric, horas_aprovadas numeric)
language sql stable security invoker set search_path = public as $$
  with d as (select vd.data, sum(vd.trabalhada_min) trab from public.vw_rel_dias vd where vd.data between p_de and p_ate group by vd.data),
       a as (select va.data, sum(va.realizada_min) real, sum(va.aprovada_min) apr from public.vw_rel_atividades va where va.data between p_de and p_ate group by va.data)
  select coalesce(d.data, a.data), round(coalesce(d.trab, 0) / 60.0, 2), round(coalesce(a.real, 0) / 60.0, 2), round(coalesce(a.apr, 0) / 60.0, 2)
    from d full join a on a.data = d.data
   order by 1;
$$;

-- 11) Dias úteis (seg-sex) sem lançamento, até hoje. Feriados e folgas não são descontados.
create or replace function public.rel_dias_sem_lancamento(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (colaborador text, gerente text, dias_uteis bigint, dias_lancados bigint, dias_sem_lancamento bigint)
language sql stable security invoker set search_path = public as $$
  with uteis as (
    select d::date as dia
      from generate_series(p_de, least(p_ate, (now() at time zone 'America/Sao_Paulo')::date), interval '1 day') d
     where extract(isodow from d) < 6)
  select u.nome_completo, coalesce(g.nome_completo, 'Sem gerente'),
         (select count(*) from uteis),
         count(*) filter (where p.id is not null),
         count(*) filter (where p.id is null)
    from public.perfis u
    left join public.perfis g on g.id = u.gestor_id
    cross join uteis
    left join public.apontamentos_ponto p on p.usuario_id = u.id and p.data = uteis.dia
   where u.role <> 'admin'
   group by u.id, u.nome_completo, g.nome_completo
   order by 5 desc, 1;
$$;

-- 12) Pendências de aprovação por idade e gerente (idade = dias desde a data da atividade)
create or replace function public.rel_pendencias_por_idade(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (gerente text, ate_2_dias bigint, de_3_a_7_dias bigint, de_8_a_14_dias bigint, mais_de_15_dias bigint, total bigint)
language sql stable security invoker set search_path = public as $$
  with p as (
    select gerente, (now() at time zone 'America/Sao_Paulo')::date - data as idade
      from public.vw_rel_atividades where status = 'Pendente' and data between p_de and p_ate)
  select gerente,
         count(*) filter (where idade <= 2),
         count(*) filter (where idade between 3 and 7),
         count(*) filter (where idade between 8 and 14),
         count(*) filter (where idade >= 15),
         count(*)
    from p group by gerente order by 6 desc, 1;
$$;

-- 13) Atividades rejeitadas, com motivo
create or replace function public.rel_rejeitadas(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (data date, colaborador text, projeto text, atividade text, horas numeric, motivo text)
language sql stable security invoker set search_path = public as $$
  select v.data, v.colaborador, v.projeto, v.descricao_atividade, round(v.realizada_min / 60.0, 2), v.motivo
    from public.vw_rel_atividades v
   where v.status = 'Glosado/Rejeitado' and v.data between p_de and p_ate
   order by v.data desc, v.colaborador;
$$;

-- 14) Intercorrências registradas
create or replace function public.rel_intercorrencias(
  p_de date default date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
  p_ate date default (now() at time zone 'America/Sao_Paulo')::date)
returns table (data date, colaborador text, projeto text, intercorrencia text)
language sql stable security invoker set search_path = public as $$
  select v.data, v.colaborador, v.projeto, v.intercorrencias
    from public.vw_rel_atividades v
   where nullif(btrim(coalesce(v.intercorrencias, '')), '') is not null and v.data between p_de and p_ate
   order by v.data desc, v.colaborador;
$$;

-- ============================================================
-- Permissões: só usuários logados (nunca anônimos)
-- ============================================================
revoke all on public.vw_rel_atividades, public.vw_rel_dias from public, anon;
grant select on public.vw_rel_atividades, public.vw_rel_dias to authenticated;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as assinatura
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'rel\_%'
  loop
    execute format('revoke all on function %s from public, anon', f.assinatura);
    execute format('grant execute on function %s to authenticated', f.assinatura);
  end loop;
end $$;
