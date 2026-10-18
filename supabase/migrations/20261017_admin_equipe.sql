-- Trackify: login de ADM por nome de usuário + ADM define quem é gerente e a equipe de cada gerente
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run
-- Pré-requisitos: 20261017_colaborador_rls_e_exclusao_segura.sql e 20261017_aprovacao_gerencia.sql.

-- Resolve o nome de usuário do ADM para o e-mail de login (só responde para perfis admin).
create or replace function public.email_do_admin(p_usuario text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
    from public.perfis p
   where p.role = 'admin'
     and lower(p.username) = lower(btrim(p_usuario))
   limit 1;
$$;
revoke all on function public.email_do_admin(text) from public;
grant execute on function public.email_do_admin(text) to anon, authenticated;

-- Só o ADM define a função (colaborador/gestor) e o gerente responsável.
create or replace function public.admin_definir_perfil(p_usuario uuid, p_role text, p_gestor uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gestor uuid := p_gestor;
begin
  if not private.is_admin() then
    raise exception 'Apenas o administrador pode alterar perfis.';
  end if;
  if p_role not in ('colaborador', 'gestor') then
    raise exception 'Função inválida.';
  end if;
  if exists (select 1 from public.perfis where id = p_usuario and role = 'admin') then
    raise exception 'O perfil de administrador não pode ser alterado por aqui.';
  end if;

  if p_role = 'gestor' then
    v_gestor := null;
  elsif v_gestor is not null then
    if v_gestor = p_usuario
       or not exists (select 1 from public.perfis where id = v_gestor and role = 'gestor') then
      raise exception 'O responsável precisa ser um gerente.';
    end if;
  end if;

  update public.perfis set role = p_role, gestor_id = v_gestor where id = p_usuario;
  if not found then
    raise exception 'Usuário não encontrado.';
  end if;

  -- gerente rebaixado deixa a equipe sem responsável
  if p_role = 'colaborador' then
    update public.perfis set gestor_id = null where gestor_id = p_usuario;
  end if;
end;
$$;
revoke all on function public.admin_definir_perfil(uuid, text, uuid) from public, anon;
grant execute on function public.admin_definir_perfil(uuid, text, uuid) to authenticated;
