-- Trackify: cadastro de projetos pela gerência
-- Aplicar no Supabase: SQL Editor -> colar tudo -> Run
-- Pré-requisito: 20261017_colaborador_rls_e_exclusao_segura.sql (cria private.is_gestor()).

-- Apenas gestor/admin cria e altera projetos (leitura continua liberada para qualquer usuário logado)
drop policy if exists projetos_insert_gestor on public.projetos;
create policy projetos_insert_gestor on public.projetos for insert to authenticated
  with check (private.is_gestor());

drop policy if exists projetos_update_gestor on public.projetos;
create policy projetos_update_gestor on public.projetos for update to authenticated
  using (private.is_gestor()) with check (private.is_gestor());

-- Não permite dois projetos com o mesmo nome, mesmo com maiúsculas/minúsculas ou espaços diferentes
create unique index if not exists projetos_nome_lower_key
  on public.projetos (lower(btrim(nome_projeto)));
