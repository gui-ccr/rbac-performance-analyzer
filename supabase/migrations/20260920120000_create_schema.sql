-- Schema base do experimento (tenants, usuários e a tabela sob teste: records).
-- Igual para o cenário RLS e para o cenário Middleware — só a presença das
-- políticas de RLS (migration seguinte) diferencia os dois cenários.

create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  department_id uuid,
  role text not null check (role in ('admin', 'manager', 'viewer')),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  owner_id uuid not null references app_users(id) on delete cascade,
  department_id uuid,
  title text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Índices que as políticas de RLS (e os filtros equivalentes do middleware)
-- vão usar em toda leitura de `records`. Sem eles, o custo do RLS a 100k
-- registros fica artificialmente pior do que seria numa implementação real.
create index if not exists idx_app_users_tenant_id on app_users (tenant_id);
create index if not exists idx_records_tenant_id on records (tenant_id);
create index if not exists idx_records_owner_id on records (owner_id);
create index if not exists idx_records_department_id on records (department_id);
create index if not exists idx_records_tenant_department on records (tenant_id, department_id);

comment on table tenants is 'Um tenant do sistema multi-tenant simulado.';
comment on table app_users is 'Usuários de teste, com o papel (role) usado pelo RBAC.';
comment on table records is 'Tabela sob teste: alvo de GET /records nos testes de carga.';
