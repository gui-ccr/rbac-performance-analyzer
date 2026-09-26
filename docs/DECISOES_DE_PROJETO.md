# Decisões de Projeto

Registro das decisões técnicas tomadas e o porquê — útil tanto para manter consistência ao longo da implementação quanto como material para a seção de metodologia da tese.

## 1. Duas APIs separadas (não uma API com flag de modo)

**Decisão:** `api-rls` e `api-middleware` são dois serviços Node.js independentes, em vez de uma única API com um `ACCESS_STRATEGY=rls|middleware` alternável.

**Motivo:** isolamento total entre as duas implementações evita que código condicional (`if (strategy === 'rls')`) introduza diferenças sutis de caminho de execução entre os dois modos, o que poderia confundir o efeito medido. O custo é manter os dois serviços em sincronia manualmente (mesmo schema, mesmos endpoints, mesma regra de RBAC) — mitigado documentando o contrato comum em [`ARQUITETURA.md`](ARQUITETURA.md).

## 2. TypeScript

**Decisão:** as duas APIs, os scripts de seed e os scripts de relatório são escritos em TypeScript.

**Motivo:** o projeto depende de manter dois códigos "espelhados" consistentes (mesmos tipos de request/response, mesmo modelo de dados) — tipagem estática ajuda a garantir que `api-rls` e `api-middleware` não divirjam de contrato sem querer.

## 3. Express (em vez de Fastify)

**Decisão:** Express como framework HTTP das duas APIs.

**Motivo:**
- O overhead do framework é uma constante presente igualmente nas duas APIs (mesmo framework nos dois lados), então não enviesa a comparação RLS vs Middleware — só eleva o baseline absoluto de latência, o que é aceitável e pode ser mencionado como limitação/contexto nos resultados.
- Express deixa a implementação da abordagem "Middleware" didaticamente explícita (`app.use(authorizeRecordsAccess)`), o que ajuda tanto na revisão do código quanto na exposição do trabalho.
- Ecossistema mais familiar para debugging e para quem for revisar/avaliar o projeto.

**Trade-off aceito:** números de latência absolutos serão mais altos do que seriam com Fastify; isso deve ser mencionado no relatório final como característica do ambiente de teste, não como resultado do experimento.

## 4. k6 como ferramenta de teste de carga

**Decisão:** k6, em vez de Artillery, autocannon ou JMeter.

**Motivo:** scripts em JavaScript (mesma linguagem do restante do projeto), métricas de latência/throughput/erro nativas com percentis, e saída em JSON compatível com o pipeline de relatórios (JSON bruto → CSV) já definido pelo autor do projeto.

## 5. Supabase como banco de dados

**Decisão:** PostgreSQL gerenciado via Supabase, em vez de Postgres local (Docker).

**Motivo:** suporta RLS nativamente (é o caso de uso principal do produto) e remove a dependência da máquina do autor para rodar os testes — importante porque testes de carga em Postgres local competiriam por CPU com o próprio gerador de carga e com o SO, invalidando a medição.

**Implicação a monitorar:** por ser um ambiente gerenciado e multi-tenant, o Supabase introduz ruído fora do controle do experimento (outros clientes na mesma infraestrutura, autoscaling, cold starts). Mitigado por repetições múltiplas por cenário (ver [`METODOLOGIA.md`](METODOLOGIA.md#8-ameaças-à-validade)).

## 6. Relatórios: JSON bruto → CSV consolidado

**Decisão:** cada execução de teste de carga gera um JSON bruto (saída nativa do k6); um script separado consolida todos os JSONs relevantes em um único CSV.

**Motivo:** o JSON preserva a granularidade total da execução (útil para reprocessar métricas depois, sem precisar rodar o teste de novo); o CSV é o formato mais direto para importar em Excel/Python/R na hora de gerar os gráficos e estatísticas da tese.

## 7. Regra de RBAC idêntica nas duas abordagens, fixada antes da coleta

**Decisão (2026-09-26):** toda leitura em `records` exige `tenant_id` = tenant do usuário, somado à restrição do papel:

| Papel | Regra |
|---|---|
| `admin` | tenant |
| `manager` | tenant **e** departamento |
| `viewer` | tenant **e** owner |

Vale para as policies de RLS (`supabase/migrations/20260926120000_rls_policies_tenant_scope.sql`) e para o filtro do middleware (`authorizeRecordsAccess`).

**Motivo:** a versão original das policies do manager (só `department_id`) e do viewer (só `owner_id`) divergia do middleware. Uma diferença de latência medida assim misturaria o efeito da estratégia (RLS vs middleware) com o de a regra de um lado ser mais simples que a do outro. Além disso, uma policy sem o `tenant_id` vazaria registros entre tenants que reaproveitem um `department_id` (demonstrado com um 2º tenant numa transação descartada), e o experimento estaria medindo o custo de uma regra que não serviria em produção.

**Como é garantido:** `npm run check:equivalence` compara, para um usuário de cada papel em cada tenant, os ids devolvidos pelas duas APIs (mesmos registros, mesma ordem). Deve passar antes de cada coleta, em cada volume de dados.

**Regra de processo:** a regra de RBAC não muda depois que a coleta de dados começa. Qualquer ajuste posterior invalida as execuções já feitas.

## 8. Estrutura do dataset: só `records` varia entre volumes

**Decisão (2026-09-26):** o gerador (`npm run seed -- --volume=N`, código em `scripts/seed/`) mantém tudo constante entre 10k/50k/100k, exceto o número de linhas em `records`:

| Parâmetro | Valor | Observação |
|---|---|---|
| Tenants | 10 | `records` distribuídos por igual (round-robin) |
| Departamentos | 5 | pool **global**, reaproveitado por todos os tenants (é o que exercita a regra tenant + departamento) |
| Usuários por tenant | 2 admin, 10 manager (2 por departamento), 50 viewer | 620 usuários no total, em qualquer volume |
| Owner de cada record | sorteado uniformemente entre os usuários do tenant | `department_id` do record = o do owner (igual ao `POST /records`) |
| Semente | `--seed=42` (PRNG mulberry32) | mesma semente => mesmos dados nos dois cenários |

**Motivo:** o volume precisa ser a única variável independente. Com estrutura fixa, o que cresce entre cenários é a densidade da tabela (10k => 100k linhas, 10x mais linhas por tenant, por departamento e por owner). Os ids de usuário são os mesmos em todos os volumes e o dataset menor é prefixo do maior, então os tokens de teste servem em qualquer cenário.

**Tamanho do resultado por papel** (varia com o volume, e é parte do que se mede): admin vê 10% da tabela (1.000 => 10.000 linhas); manager ~1% a 3% (95-315 => 962-3.185); viewer 7-26 => 129-202. Como o viewer sorteia o departamento, o tamanho por departamento não é uniforme.

**Cuidados no script:** tudo numa transação (com `--dry-run` que faz rollback); verifica contagens totais e a visibilidade esperada por papel antes do commit; roda `ANALYZE` depois, para o planner decidir com estatísticas atuais; substitui os dados existentes (inclui o `supabase/seed.sql`).

---

## Pendências (a decidir antes da implementação)

### Onde rodar `api-rls` / `api-middleware` durante os testes

Se as APIs rodarem na máquina local do autor enquanto o k6 também roda localmente, há contenção de recursos entre gerador de carga e servidor testado, o que pode distorcer tanto a latência quanto a leitura de CPU da API. Opções a avaliar:

- Rodar a API em uma VM/serviço gratuito (Render, Railway, Fly.io) separado da máquina que roda o k6.
- Rodar o k6 na nuvem (k6 Cloud tem free tier limitado) apontando para a API local — inverte o problema, não resolve sozinho.
- Se ambos rodarem localmente, ao menos documentar como limitação e evitar tirar conclusões de CPU da própria API (manter o foco na CPU do banco, que é o objeto central da hipótese).

**Ação:** decidir antes de escrever os scripts de teste de carga, pois define a `BASE_URL` usada nos cenários k6.

### Plano do Supabase e granularidade de métricas de CPU

Confirmar se o plano gratuito do Supabase expõe métricas de CPU do banco com granularidade suficiente (painel *Database → Reports*) para as janelas de teste (minutos), ou se será necessário um plano pago / coleta alternativa (ex. `pg_stat_activity`, extensões de observabilidade).

**Ação:** validar no painel do Supabase antes de finalizar `docs/TESTES_DE_CARGA.md#coleta-de-cpu-fora-do-k6`.
