-- Trackify: o primeiro cadastro com o e-mail do Funchal já nasce como ADM
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run
--
-- Regras de segurança desta promoção automática:
--  * só vale para o e-mail abaixo (nunca para "nome" ou "usuário", que o cliente pode escolher);
--  * só vale enquanto NÃO existir nenhum ADM: depois do primeiro, todo novo cadastro volta a ser colaborador;
--  * por isso, cadastre o Funchal logo depois de aplicar este script.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_inicial constant text := 'funchal@funchalnegocios.com.br';
  v_role text := 'colaborador';
begin
  if lower(btrim(new.email)) = v_admin_inicial
     and not exists (select 1 from public.perfis where role = 'admin') then
    v_role := 'admin';
  end if;

  insert into public.perfis (id, nome_completo, username, role, sexo, celular, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome_completo', new.email),
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    v_role,
    new.raw_user_meta_data->>'sexo',
    new.raw_user_meta_data->>'celular',
    new.email
  );
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
