# Supabase — Migrations

Scripts SQL versionados que configuram o cenário **RLS** do experimento: schema, role de conexão dedicado e as políticas de RBAC. Ver o raciocínio completo em [`../docs/ARQUITETURA.md`](../docs/ARQUITETURA.md) e [`../docs/POLITICAS_RLS.md`](../docs/POLITICAS_RLS.md).

## Arquivos

```
supabase/
├── migrations/
│   ├── 20260920120000_create_schema.sql        # tenants, app_users, records + índices
│   ├── 20260920120100_create_rls_client_role.sql # role app_rls_client (sem BYPASSRLS)
│   ├── 20260920120200_enable_rls_records.sql     # RLS + políticas admin/manager/viewer
│   └── 20260926120000_rls_policies_tenant_scope.sql # manager/viewer passam a exigir tenant_id também
└── seed.sql                                      # dados mínimos para testar as políticas manualmente
```

As migrations são numeradas e **devem rodar nessa ordem** — cada uma depende da anterior.

## Como rodar

### Opção A — Supabase CLI (recomendado)

```bash
npm install -g supabase   # se ainda não tiver
supabase login
supabase link --project-ref <seu-project-ref>

# aplica as 4 migrations, em ordem, no banco remoto
supabase db push
```

### Opção B — SQL Editor do painel do Supabase (sem instalar nada)

1. Abra o projeto no [supabase.com/dashboard](https://supabase.com/dashboard) → **SQL Editor**.
2. Cole e rode o conteúdo de `migrations/20260920120000_create_schema.sql`.
3. Cole e rode `migrations/20260920120100_create_rls_client_role.sql`.
4. **Defina a senha do role** (não está no arquivo, é secreto — ver comentário no próprio arquivo):
   ```sql
   alter role app_rls_client with password '<gere uma senha forte>';
   ```
   Guarde essa senha em `apps/api-rls/.env` (a criar) — nunca em um arquivo versionado.
5. Cole e rode `migrations/20260920120200_enable_rls_records.sql`.
6. Cole e rode `migrations/20260926120000_rls_policies_tenant_scope.sql`.
7. (Opcional, para testar manualmente) cole e rode `seed.sql`.

## Validar que o RLS está funcionando

Depois de rodar as migrations + o seed, no SQL Editor (que roda como `postgres`, que faz *bypass* de RLS — não serve pra validar nada sozinho). Para validar de verdade, simule uma sessão do role `app_rls_client`:

```sql
set role app_rls_client;
select set_config('app.current_user_id', '44444444-4444-4444-4444-444444444444', false); -- viewer

select * from records; -- deve retornar só o record do viewer (1 linha)

reset role;
```

Troque o `current_user_id` pelo id do admin/manager do `seed.sql` e confirme que cada um vê exatamente o esperado pela matriz de RBAC. O roteiro completo de teste (todas as combinações) está em [`../docs/POLITICAS_RLS.md`](../docs/POLITICAS_RLS.md).

## Próximos passos

- `scripts/seed/` (a implementar): gerador dos volumes reais do experimento (10k/50k/100k registros), reaproveitando o mesmo schema.
- Repetir este mesmo schema (sem as migrations de RLS) para o cenário `api-middleware`, em um projeto/schema Supabase separado — ver pendência em [`../docs/DECISOES_DE_PROJETO.md`](../docs/DECISOES_DE_PROJETO.md).
