-- Habilita RLS em `records` e define as políticas de RBAC:
--   admin   -> vê todos os records do próprio tenant
--   manager -> vê os records do próprio tenant + próprio departamento
--   viewer  -> vê só os records dos quais é owner
--
-- A api-rls nunca informa o papel do usuário ao banco: só a identidade
-- verificada (`app.current_user_id`, setada por requisição via
-- `set_config`). O papel é sempre resolvido aqui, a partir de `app_users`
-- — é essa consulta repetida por linha que a tese quer medir conforme
-- `records` cresce. Detalhes e matriz de teste em ../../docs/POLITICAS_RLS.md.

create or replace function app_current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid;
$$;

alter table records enable row level security;

drop policy if exists records_select_admin on records;
create policy records_select_admin on records
  for select
  using (
    tenant_id = (select tenant_id from app_users where id = app_current_user_id())
    and (select role from app_users where id = app_current_user_id()) = 'admin'
  );

drop policy if exists records_select_manager on records;
create policy records_select_manager on records
  for select
  using (
    department_id = (select department_id from app_users where id = app_current_user_id())
    and (select role from app_users where id = app_current_user_id()) = 'manager'
  );

drop policy if exists records_select_viewer on records;
create policy records_select_viewer on records
  for select
  using (
    owner_id = app_current_user_id()
    and (select role from app_users where id = app_current_user_id()) = 'viewer'
  );

-- Qualquer papel pode criar um record, desde que fique associado ao
-- próprio tenant e ao próprio usuário como owner (POST /records).
drop policy if exists records_insert_own on records;
create policy records_insert_own on records
  for insert
  with check (
    owner_id = app_current_user_id()
    and tenant_id = (select tenant_id from app_users where id = app_current_user_id())
  );
