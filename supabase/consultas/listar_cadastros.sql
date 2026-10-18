-- Trackify: lista todos os cadastros (somente leitura, não altera nada)
-- Como usar: Supabase -> SQL Editor -> colar tudo -> Run.
-- O SQL Editor mostra o resultado da ÚLTIMA consulta; para ver as outras, rode uma de cada vez
-- (selecione o trecho e clique em Run) ou use as abas de resultado, se o seu editor mostrar.

-- 1) Usuários (perfis) com gerente, situação do e-mail e último acesso
select
  p.nome_completo                                         as nome,
  p.username                                              as usuario,
  p.email,
  case p.role when 'admin' then 'ADM' when 'gestor' then 'Gerente' else 'Colaborador' end as funcao,
  coalesce(g.nome_completo, '—')                          as gerente,
  p.sexo,
  p.celular,
  case when u.email_confirmed_at is not null then 'Sim' else 'Não' end as email_confirmado,
  to_char(p.criado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')          as cadastrado_em,
  to_char(u.last_sign_in_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')    as ultimo_acesso
from public.perfis p
left join public.perfis g on g.id = p.gestor_id
left join auth.users u    on u.id = p.id
order by p.criado_em;

-- 2) Projetos
select id, nome_projeto as projeto, descricao,
       case when ativo then 'Ativo' else 'Inativo' end as situacao,
       to_char(criado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as cadastrado_em
from public.projetos
order by id;

-- 3) Tipos de atividade
select id, nome as tipo_atividade,
       case when ativo then 'Ativo' else 'Inativo' end as situacao
from public.tipos_atividade
order by id;

-- 4) Resumo: quantos registros há em cada tabela
select 'Usuários (perfis)'         as cadastro, count(*) as total from public.perfis
union all select '  Colaboradores',            count(*) from public.perfis where role = 'colaborador'
union all select '  Gerentes',                 count(*) from public.perfis where role = 'gestor'
union all select '  ADM',                      count(*) from public.perfis where role = 'admin'
union all select 'Projetos',                   count(*) from public.projetos
union all select 'Tipos de atividade',         count(*) from public.tipos_atividade
union all select 'Dias de ponto lançados',     count(*) from public.apontamentos_ponto
union all select 'Atividades lançadas',        count(*) from public.apontamentos_atividades;
