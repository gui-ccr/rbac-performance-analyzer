# Arquitetura

## Visão geral

Duas APIs Node.js/Express, funcionalmente idênticas do ponto de vista do consumidor (mesmas rotas, mesmos contratos de request/response), diferindo **apenas** em onde a regra de autorização RBAC é aplicada:

```
┌──────────────┐        ┌──────────────────┐        ┌────────────────────────────┐
│   k6 (carga)  │──────▶│   api-rls         │──────▶│  Postgres (Supabase)        │
│               │        │   query "crua"    │        │  RLS policies filtram as    │
│               │        │   sem filtro       │        │  linhas por role/tenant     │
└──────────────┘        └──────────────────┘        └────────────────────────────┘

┌──────────────┐        ┌──────────────────┐        ┌────────────────────────────┐
│   k6 (carga)  │──────▶│   api-middleware  │──────▶│  Postgres (Supabase)         │
│               │        │   middleware monta │        │  RLS desabilitado,           │
│               │        │   WHERE conforme   │        │  recebe query já filtrada    │
│               │        │   o papel do user  │        │                              │
└──────────────┘        └──────────────────┘        └────────────────────────────┘
```

As duas APIs devem rodar contra **projetos/schemas Supabase equivalentes** (mesmo schema de tabelas, mesmos índices, mesmos dados de seed), diferindo apenas na presença/ausência das políticas de RLS. Isso garante que a única variável manipulada seja a estratégia de controle de acesso.

## Modelo de dados

Domínio de exemplo: um sistema multi-tenant de **registros de atendimento** (`records`), simples o bastante para não introduzir variáveis de confusão na medição.

```sql
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table app_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  role text not null check (role in ('admin', 'manager', 'viewer')),
  department_id uuid,
  email text not null unique
);

create table records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  owner_id uuid not null references app_users(id),
  department_id uuid,
  title text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index on records (tenant_id);
create index on records (owner_id);
create index on records (department_id);
```

### Regra de RBAC (idêntica nas duas abordagens)

| Papel | Pode ver |
|---|---|
| `admin` | Todos os registros do próprio tenant |
| `manager` | Registros do próprio tenant **e** do próprio departamento |
| `viewer` | Registros do próprio tenant dos quais é `owner` |

Essa regra é o "contrato" que as duas implementações precisam cumprir de forma equivalente — é o que deve ser revisado antes da coleta de dados (ver ameaça à validade em [`METODOLOGIA.md`](METODOLOGIA.md#8-ameaças-à-validade)).

## Abordagem 1 — `api-rls`

`api-rls` conecta direto no Postgres via `pg` (não via PostgREST/Supabase client SDK), então **não** usamos `auth.uid()` do Supabase Auth — esse mecanismo só é populado quando a requisição passa pelo PostgREST. Em vez disso:

- A API valida o JWT do usuário e extrai o `user_id` (identidade **verificada** criptograficamente).
- Para cada requisição, abre uma transação e propaga essa identidade para o Postgres via uma variável de sessão local à transação: `select set_config('app.current_user_id', $1, true)`.
- A query executada pela API é sempre `select * from records` (sem `WHERE` de autorização) — é o banco que filtra, consultando `app_users` para descobrir o papel/tenant/departamento de quem está logado.
- **A aplicação nunca informa o papel do usuário ao banco** — só a identidade verificada. O papel é sempre resolvido pela policy a partir de `app_users`, para que a decisão de autorização continue vivendo inteiramente na camada de dados.

RLS habilitado e políticas (ver migrations em [`../supabase/migrations`](../supabase/migrations) e detalhes de teste em [`POLITICAS_RLS.md`](POLITICAS_RLS.md)):

```sql
alter table records enable row level security;

create policy records_select_admin on records
  for select
  using (
    tenant_id = (select tenant_id from app_users where id = app_current_user_id())
    and (select role from app_users where id = app_current_user_id()) = 'admin'
  );

create policy records_select_manager on records
  for select
  using (
    tenant_id = (select tenant_id from app_users where id = app_current_user_id())
    and department_id = (select department_id from app_users where id = app_current_user_id())
    and (select role from app_users where id = app_current_user_id()) = 'manager'
  );

create policy records_select_viewer on records
  for select
  using (
    tenant_id = (select tenant_id from app_users where id = app_current_user_id())
    and owner_id = app_current_user_id()
    and (select role from app_users where id = app_current_user_id()) = 'viewer'
  );
```

`app_current_user_id()` é uma função `STABLE` que só faz `current_setting('app.current_user_id', true)::uuid` — existe para não espalhar a leitura da GUC por todas as policies. Detalhes completos, matriz de testes e as duas armadilhas mais importantes de RLS (role de conexão com `BYPASSRLS`/superuser ignora as políticas silenciosamente; `set_config(..., true)` exige que o `set` e a query aconteçam **na mesma transação/conexão**) estão em [`POLITICAS_RLS.md`](POLITICAS_RLS.md).

> Nota metodológica: as subqueries em cada policy (`select role from app_users where id = ...`) são exatamente o tipo de custo que a tese espera medir — é aqui que o gargalo de RLS tende a aparecer conforme a tabela cresce, especialmente sem os índices corretos.

## Abordagem 2 — `api-middleware`

- RLS **desabilitado** na tabela `records` (ou uma policy `using (true)` para o role usado pela API).
- Um middleware Express, executado antes do handler da rota, resolve o papel do usuário (mesma fonte de verdade: tabela `app_users`) e decide **como montar o `WHERE`** da query.

```ts
async function authorizeRecordsAccess(req: Request, res: Response, next: NextFunction) {
  const user = await getUserFromToken(req); // { id, tenantId, role, departmentId }

  if (user.role === 'admin') {
    req.recordsFilter = { tenant_id: user.tenantId };
  } else if (user.role === 'manager') {
    req.recordsFilter = { tenant_id: user.tenantId, department_id: user.departmentId };
  } else {
    req.recordsFilter = { tenant_id: user.tenantId, owner_id: user.id };
  }

  next();
}
```

O handler da rota usa `req.recordsFilter` para montar a query (`select * from records where tenant_id = $1 and owner_id = $2`, etc.) — o filtro é aplicado **antes** de a query chegar ao banco, mas construído pela aplicação.

## Endpoints (iguais nas duas APIs)

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/records` | Lista registros visíveis ao usuário autenticado, respeitando RBAC. Suporta paginação (`?page=&pageSize=`). |
| `GET` | `/records/:id` | Detalhe de um registro (404 se não visível ao usuário). |
| `POST` | `/records` | Cria um registro associado ao usuário autenticado. |

O alvo principal dos testes de carga é `GET /records`, por ser a operação onde o filtro de RBAC (RLS ou middleware) mais pesa conforme o volume de dados cresce (leitura ampla vs. gravação pontual).

## Autenticação usada nos testes

Para isolar a variável de estudo, a autenticação em si deve ser **leve e idêntica** nas duas APIs (ex.: JWT pré-gerado por usuário de teste, sem custo adicional de rede a cada requisição). Detalhes de geração de usuários/JWTs de teste ficam no gerador de seed (`scripts/seed/`, a implementar).
