-- Trackify: inativar/editar pessoas + fechamento mensal
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run (pode rodar mais de uma vez sem problema)
--
-- O que muda:
--  1) perfis.ativo: o ADM inativa/reativa pessoas. Pessoa inativa não consegue entrar
--     (o login é bloqueado no Supabase Auth) e mantém todo o histórico.
--  2) O ADM edita nome, celular, sexo e "permite fim de semana" de qualquer pessoa.
--  3) fechamentos_mes: o ADM fecha um mês já encerrado. Em mês fechado ninguém cria,
--     altera ou exclui lançamentos e atividades (nem gerente avaliando) até o ADM reabrir.

-- ============================================================
-- 1) Ativo / inativo
-- ============================================================
alter table public.perfis add column if not exists ativo boolean not null default true;

create or replace function public.admin_definir_ativo(p_usuario uuid, p_ativo boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_equipe int;
begin
  if not private.is_admin() then
    raise exception 'Apenas o administrador pode inativar ou reativar pessoas.';
  end if;
  if p_usuario = auth.uid() then
    raise exception 'Você não pode inativar a própria conta.';
  end if;
  select role into v_role from public.perfis where id = p_usuario;
  if v_role is null then
    raise exception 'Usuário não encontrado.';
  end if;
  if v_role = 'admin' then
    raise exception 'Um administrador não pode ser inativado por aqui.';
  end if;

  if not p_ativo and v_role = 'gestor' then
    select count(*) into v_equipe from public.perfis where gestor_id = p_usuario and ativo;
    if v_equipe > 0 then
      raise exception 'Este gerente ainda tem % pessoa(s) ativa(s) na equipe. Mude-as para outro gerente antes de inativar.', v_equipe;
    end if;
  end if;

  update public.perfis set ativo = p_ativo, atualizado_em = now() where id = p_usuario;

  if p_ativo then
    update auth.users set banned_until = null, updated_at = now() where id = p_usuario;
  else
    -- bloqueia novos logins e derruba os acessos abertos
    update auth.users set banned_until = now() + interval '100 years', updated_at = now() where id = p_usuario;
    delete from auth.refresh_tokens where user_id = p_usuario::text;
    delete from auth.sessions where user_id = p_usuario;
  end if;
end;
$$;
revoke all on function public.admin_definir_ativo(uuid, boolean) from public, anon;
grant execute on function public.admin_definir_ativo(uuid, boolean) to authenticated;

-- ============================================================
-- 2) Editar dados cadastrais (ADM)
-- ============================================================
create or replace function public.admin_editar_perfil(
  p_usuario uuid, p_nome text, p_celular text, p_sexo text, p_fim_semana boolean)
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
  if not exists (select 1 from public.perfis where id = p_usuario) then
    raise exception 'Usuário não encontrado.';
  end if;
  update public.perfis
     set nome_completo = v_nome,
         celular = nullif(btrim(coalesce(p_celular, '')), ''),
         sexo = nullif(btrim(coalesce(p_sexo, '')), ''),
         permite_fim_semana = coalesce(p_fim_semana, false),
         atualizado_em = now()
   where id = p_usuario;
end;
$$;
revoke all on function public.admin_editar_perfil(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.admin_editar_perfil(uuid, text, text, text, boolean) to authenticated;

-- Quem está inativo não grava mais nada, mesmo com um acesso antigo ainda válido
-- (ver private.trava_periodo_e_inativos, abaixo).

-- Relatório "dias sem lançamento": pessoas inativas saem da cobrança
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
   where u.role <> 'admin' and u.ativo
   group by u.id, u.nome_completo, g.nome_completo
   order by 5 desc, 1;
$$;

-- ============================================================
-- 3) Fechamento mensal
-- ============================================================
create table if not exists public.fechamentos_mes (
  mes         date primary key check (mes = date_trunc('month', mes)::date),
  fechado_em  timestamptz not null default now(),
  fechado_por uuid references public.perfis(id) on delete set null,
  observacao  text
);
alter table public.fechamentos_mes enable row level security;
drop policy if exists fechamentos_select on public.fechamentos_mes;
create policy fechamentos_select on public.fechamentos_mes for select to authenticated using (true);
revoke all on public.fechamentos_mes from anon, authenticated;
grant select on public.fechamentos_mes to authenticated;

-- Trava: mês fechado e pessoa inativa não gravam. Quem não tem usuário (SQL Editor/service role) passa.
create or replace function private.trava_periodo_e_inativos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_datas date[];
  v_d date;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  if exists (select 1 from public.perfis where id = auth.uid() and not ativo) then
    raise exception 'Sua conta está inativa. Fale com o administrador.';
  end if;

  v_datas := array[
    case when tg_op <> 'INSERT' then old.data end,
    case when tg_op <> 'DELETE' then new.data end];
  foreach v_d in array v_datas loop
    if v_d is not null and exists (
         select 1 from public.fechamentos_mes f where f.mes = date_trunc('month', v_d)::date) then
      raise exception 'O mês de % está fechado e não aceita alterações. Peça ao administrador para reabri-lo.',
        to_char(v_d, 'MM/YYYY');
    end if;
  end loop;

  return coalesce(new, old);
end;
$$;
revoke all on function private.trava_periodo_e_inativos() from public, anon, authenticated;

drop trigger if exists trg_trava_periodo_ponto on public.apontamentos_ponto;
create trigger trg_trava_periodo_ponto before insert or update or delete on public.apontamentos_ponto
  for each row execute function private.trava_periodo_e_inativos();
drop trigger if exists trg_trava_periodo_atividades on public.apontamentos_atividades;
create trigger trg_trava_periodo_atividades before insert or update or delete on public.apontamentos_atividades
  for each row execute function private.trava_periodo_e_inativos();

-- Fechar: só meses já encerrados e sem atividades pendentes de avaliação.
-- A trava vem do gatilho acima (não depende de marcar cada registro), então reabrir devolve tudo como estava.
create or replace function public.admin_fechar_mes(p_mes date, p_observacao text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes date := date_trunc('month', p_mes)::date;
  v_hoje_mes date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  v_pend int;
begin
  if not private.is_admin() then
    raise exception 'Apenas o administrador pode fechar o mês.';
  end if;
  if v_mes >= v_hoje_mes then
    raise exception 'Só é possível fechar meses já encerrados.';
  end if;
  if exists (select 1 from public.fechamentos_mes where mes = v_mes) then
    raise exception 'Este mês já está fechado.';
  end if;
  select count(*) into v_pend
    from public.apontamentos_atividades a
   where a.data >= v_mes and a.data < (v_mes + interval '1 month')::date
     and a.status_aprovacao is not distinct from 'Pendente';
  if v_pend > 0 then
    raise exception 'Há % atividade(s) pendente(s) de avaliação em %. Avalie todas antes de fechar o mês.',
      v_pend, to_char(v_mes, 'MM/YYYY');
  end if;

  insert into public.fechamentos_mes (mes, fechado_por, observacao)
  values (v_mes, auth.uid(), nullif(btrim(coalesce(p_observacao, '')), ''));

end;
$$;
revoke all on function public.admin_fechar_mes(date, text) from public, anon;
grant execute on function public.admin_fechar_mes(date, text) to authenticated;

create or replace function public.admin_reabrir_mes(p_mes date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes date := date_trunc('month', p_mes)::date;
begin
  if not private.is_admin() then
    raise exception 'Apenas o administrador pode reabrir o mês.';
  end if;
  delete from public.fechamentos_mes where mes = v_mes;
  if not found then
    raise exception 'Este mês não está fechado.';
  end if;
end;
$$;
revoke all on function public.admin_reabrir_mes(date) from public, anon;
grant execute on function public.admin_reabrir_mes(date) to authenticated;
