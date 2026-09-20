-- Seed MÍNIMO para validar manualmente as políticas de RLS (não é o
-- gerador de carga de 10k/50k/100k registros — esse fica em
-- `scripts/seed/`, ainda a implementar).
--
-- Cria 1 tenant, 2 departamentos (implícitos via uuid), 3 usuários (um
-- por papel) e alguns records, para testar cada policy manualmente pelo
-- SQL editor do Supabase. Ver docs/POLITICAS_RLS.md para os testes.

insert into tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Tenant de Teste')
on conflict (id) do nothing;

-- department_id é só um uuid arbitrário reaproveitado nos records; não
-- existe tabela `departments` no schema atual (fora de escopo do RBAC).
insert into app_users (id, tenant_id, department_id, role, email) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin',   'admin@teste.com'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'manager', 'manager@teste.com'),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'viewer',  'viewer@teste.com')
on conflict (id) do nothing;

-- Records: um no departamento do manager/admin, um no departamento do viewer,
-- um pertencente ao próprio viewer.
insert into records (tenant_id, owner_id, department_id, title, payload) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'Record do admin (dept 1)', '{}'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000001', 'Record do manager (dept 1)', '{}'),
  ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'aaaaaaaa-0000-0000-0000-000000000002', 'Record do viewer (dept 2)', '{}');
