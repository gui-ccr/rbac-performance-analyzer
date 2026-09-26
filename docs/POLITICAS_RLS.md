# Políticas de RLS

Documentação das políticas de Row-Level Security aplicadas em `records` pelo cenário `api-rls`. SQL correspondente em [`../supabase/migrations/20260920120200_enable_rls_records.sql`](../supabase/migrations/20260920120200_enable_rls_records.sql), com as policies de manager e viewer substituídas por [`20260926120000_rls_policies_tenant_scope.sql`](../supabase/migrations/20260926120000_rls_policies_tenant_scope.sql) (escopo por tenant — ver decisão 7 em [`DECISOES_DE_PROJETO.md`](DECISOES_DE_PROJETO.md)).

## Como a identidade chega ao banco

`api-rls` conecta ao Postgres com um role dedicado (`app_rls_client`, sem `BYPASSRLS`/superuser — ver [`../supabase/migrations/20260920120100_create_rls_client_role.sql`](../supabase/migrations/20260920120100_create_rls_client_role.sql)). A cada requisição:

1. A API valida o JWT do usuário e extrai `user_id`.
2. Abre uma transação e roda `select set_config('app.current_user_id', $1, true)` — o `true` no final é o que torna essa variável local à transação (equivalente a `SET LOCAL`), então ela não vaza entre requisições que reaproveitam a mesma conexão do pool.
3. Roda a query de negócio (`select * from records`) **na mesma transação**.
4. Comita.

A função `app_current_user_id()` (SQL, `STABLE`) só encapsula a leitura dessa variável:

```sql
select nullif(current_setting('app.current_user_id', true), '')::uuid;
```

O **papel** do usuário nunca é enviado pela API — cada policy resolve `role`/`tenant_id`/`department_id` consultando `app_users` a partir do `user_id` verificado. Isso é proposital: a autorização continua sendo uma decisão do banco, não algo que a aplicação declara e o banco confia cegamente.

## Políticas

| Policy | Operação | Regra |
|---|---|---|
| `records_select_admin` | `SELECT` | `tenant_id` do record == `tenant_id` do usuário, **e** papel do usuário == `admin` |
| `records_select_manager` | `SELECT` | `tenant_id` do record == tenant do usuário, **e** `department_id` do record == `department_id` do usuário, **e** papel do usuário == `manager` |
| `records_select_viewer` | `SELECT` | `tenant_id` do record == tenant do usuário, **e** `owner_id` do record == id do usuário, **e** papel do usuário == `viewer` |
| `records_insert_own` | `INSERT` | novo record precisa ter `owner_id` == id do usuário **e** `tenant_id` == tenant do usuário (qualquer papel) |

Políticas de `SELECT` são **permissivas** (padrão do Postgres) — o resultado final é o OU lógico das três. Um usuário só tem um papel por vez (`app_users.role`), então na prática exatamente uma das três é relevante por sessão.

## Matriz de teste manual

Usando os dados de [`../supabase/seed.sql`](../supabase/seed.sql) (1 tenant, 1 admin, 1 manager, 1 viewer, 3 records — um por usuário). Roteiro de execução em [`../supabase/README.md`](../supabase/README.md#validar-que-o-rls-está-funcionando).

| `app.current_user_id` | Papel | `select * from records` deve retornar |
|---|---|---|
| `22222222-...` | admin | as 3 linhas (todo o tenant) |
| `33333333-...` | manager | 2 linhas (as do departamento `aaaaaaaa-...0001`: admin + manager) |
| `44444444-...` | viewer | 1 linha (só a própria, departamento `aaaaaaaa-...0002`) |
| *(não setado)* | — | 0 linhas (nenhuma policy casa com `user_id` nulo) |

Se qualquer uma dessas contagens vier diferente do esperado, **não** siga para os testes de carga — significa que a regra de RBAC do RLS diverge da regra que o middleware vai implementar, o que invalidaria a comparação (ver ameaça à validade em [`METODOLOGIA.md`](METODOLOGIA.md#8-ameaças-à-validade)).

## Armadilhas verificadas

- **RLS ignorado silenciosamente:** roles com `BYPASSRLS`, superusers, e o *owner* da tabela não passam pelas políticas — o Postgres não avisa, só retorna tudo. O role `postgres`/`service_role` do Supabase cai nessa categoria. Por isso a api-rls **precisa** usar `app_rls_client`; testar pelo SQL Editor do painel (que roda como `postgres`) não valida nada sozinho, é preciso `set role app_rls_client` antes.
- **`set_config` fora de transação:** `select set_config('app.current_user_id', $1, true)` só tem efeito dentro de uma transação (`true` = local à transação, como `SET LOCAL`). Se a API não envolver o `set_config` + a query numa mesma transação/conexão, a variável nunca chega a valer nada e toda policy resolve para `NULL`, retornando 0 linhas.
- **`department_id` nulo:** `app_users.department_id` e `records.department_id` são `uuid` nullable. A policy do `manager` usa `=`, que nunca é verdadeiro contra `NULL` — um manager sem `department_id` definido não vê nada. Isso é o comportamento esperado (falha fechada), mas vale checar no seed/gerador de carga que todo manager/record de teste tenha `department_id` preenchido.

## Equivalência com `api-middleware`

A regra de RBAC é a mesma nas duas abordagens (decisão 7 em [`DECISOES_DE_PROJETO.md`](DECISOES_DE_PROJETO.md)). Verificação automática: `npm run check:equivalence`, que compara os ids devolvidos pelas duas APIs, por papel e por tenant. Rodar antes de cada coleta, em cada volume (10k/50k/100k).

Validação da migration `20260926120000` (feita numa transação descartada, com um 2º tenant reaproveitando o mesmo `department_id`): antes dela, o manager do tenant 1 enxergava o registro do tenant 2; depois, cada manager vê só o próprio tenant, e o viewer continua vendo 1 linha.
