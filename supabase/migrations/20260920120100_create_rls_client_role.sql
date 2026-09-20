-- Role dedicado para a conexão da api-rls com o Postgres.
--
-- ARMADILHA IMPORTANTE: RLS é ignorado silenciosamente por roles com
-- BYPASSRLS, por superusers, e pelo dono (owner) da tabela. O role
-- `postgres`/`service_role` do Supabase cai em uma dessas categorias —
-- se a api-rls conectar com esse role, as políticas nunca são aplicadas
-- e os testes ficam medindo "sem RLS" achando que é "com RLS".
--
-- Por isso a api-rls DEVE se conectar com este role dedicado, sem
-- privilégios de bypass.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rls_client') then
    create role app_rls_client with login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

-- A senha NÃO fica no migration (fica versionado no git). Depois de rodar
-- esta migration, defina a senha manualmente (SQL editor do Supabase ou
-- `psql`) e salve em `apps/api-rls/.env`, nunca aqui:
--
--   alter role app_rls_client with password '<gere uma senha forte>';

grant usage on schema public to app_rls_client;

-- Necessário para as subqueries das policies (records -> app_users).
grant select on app_users to app_rls_client;
grant select on tenants to app_rls_client;

-- A api-rls só precisa ler e criar records; toda restrição de quais
-- linhas ela lê/grava vem das políticas de RLS, não de GRANT.
grant select, insert on records to app_rls_client;
