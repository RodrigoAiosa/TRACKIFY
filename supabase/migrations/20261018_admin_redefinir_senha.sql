-- Trackify: o ADM redefine a senha de quem esqueceu (sem depender de e-mail)
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run
-- Pré-requisitos: 20261017_aprovacao_gerencia.sql (cria private.is_admin()).
--
-- Fluxo: ADM clica em "Redefinir senha" na aba Equipe -> o sistema gera uma senha temporária,
-- mostra UMA vez para o ADM repassar -> no primeiro acesso a pessoa é obrigada a criar uma senha nova.

alter table public.perfis add column if not exists trocar_senha boolean not null default false;

create or replace function public.admin_redefinir_senha(p_usuario uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  maiusc constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  minusc constant text := 'abcdefghijkmnpqrstuvwxyz';
  digitos constant text := '23456789';
  tudo   constant text := maiusc || minusc || digitos;
  rb bytea := gen_random_bytes(12);
  senha text;
  i int;
begin
  if not private.is_admin() then
    raise exception 'Apenas o administrador pode redefinir senhas.';
  end if;
  if p_usuario = auth.uid() then
    raise exception 'Para trocar a sua própria senha, use "Esqueci minha senha" ou a tela de login.';
  end if;
  if not exists (select 1 from public.perfis where id = p_usuario) then
    raise exception 'Usuário não encontrado.';
  end if;
  if exists (select 1 from public.perfis where id = p_usuario and role = 'admin') then
    raise exception 'A senha de outro administrador não pode ser redefinida por aqui.';
  end if;

  -- senha temporária: 1 maiúscula, 1 minúscula, 1 dígito e mais 9 caracteres (sem letras ambíguas como O/0, l/1)
  senha := substr(maiusc, 1 + get_byte(rb, 0) % length(maiusc), 1)
        || substr(minusc, 1 + get_byte(rb, 1) % length(minusc), 1)
        || substr(digitos, 1 + get_byte(rb, 2) % length(digitos), 1);
  for i in 3..11 loop
    senha := senha || substr(tudo, 1 + get_byte(rb, i) % length(tudo), 1);
  end loop;

  update auth.users
     set encrypted_password = crypt(senha, gen_salt('bf', 10)),
         updated_at = now()
   where id = p_usuario;

  -- derruba os logins abertos dessa pessoa
  delete from auth.refresh_tokens where user_id = p_usuario::text;
  delete from auth.sessions where user_id = p_usuario;

  update public.perfis set trocar_senha = true where id = p_usuario;
  return senha;
end;
$$;
revoke all on function public.admin_redefinir_senha(uuid) from public, anon;
grant execute on function public.admin_redefinir_senha(uuid) to authenticated;

-- Chamada pela própria pessoa depois de criar a senha nova
create or replace function public.concluir_troca_senha()
returns void
language sql
security definer
set search_path = public
as $$
  update public.perfis set trocar_senha = false where id = auth.uid();
$$;
revoke all on function public.concluir_troca_senha() from public, anon;
grant execute on function public.concluir_troca_senha() to authenticated;
