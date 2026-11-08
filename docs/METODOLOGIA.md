# Metodologia Experimental

## 1. Problema de pesquisa

Em sistemas multi-tenant, o controle de acesso baseado em papéis (RBAC) pode ser implementado em pelo menos duas camadas:

- **Middleware (camada de aplicação):** a API recebe a requisição, identifica o papel do usuário e constrói/filtra a query antes de enviá-la ao banco. O banco de dados não tem noção de RBAC — só recebe SQL já restrito.
- **Row-Level Security — RLS (camada de dados):** a API envia a query "crua"; o PostgreSQL aplica políticas de segurança por linha, definidas no schema, que filtram o resultado com base no papel/identidade do usuário autenticado na sessão.

Não há consenso claro sobre qual abordagem escala melhor conforme o volume de dados cresce. A escolha impacta diretamente a arquitetura de sistemas multi-tenant de médio/grande porte.

## 2. Hipótese

**H1 (hipótese defendida):** o RLS degrada a performance (latência e uso de CPU) mais do que o Middleware conforme o volume de dados aumenta.

**H0 (hipótese nula):** não há diferença estatisticamente significativa na degradação de performance entre RLS e Middleware conforme o volume de dados aumenta — ou o Middleware degrada igual/mais.

## 3. Método

Método **experimental**, com manipulação controlada de uma variável independente (volume de dados) e medição do efeito sobre variáveis dependentes de performance, comparando dois grupos (estratégia RLS vs estratégia Middleware).

## 4. Variáveis

### 4.1 Variável independente

- **Volume de dados** na tabela sob teste: 10.000 / 50.000 / 100.000 registros.

### 4.2 Variável de tratamento (fator comparado)

- **Estratégia de controle de acesso:** RLS vs Middleware.

### 4.3 Variáveis dependentes (métricas coletadas)

| Métrica | Descrição | Como é coletada |
|---|---|---|
| Latência (p50, p90, p95, p99) | Tempo de resposta da requisição, em ms | k6 (`http_req_duration`) |
| Throughput | Requisições/segundo sustentadas | k6 (`http_reqs`) |
| Taxa de erro | % de requisições com status ≥ 400 ou timeout | k6 (`http_req_failed`) |
| Uso de CPU/memória — servidor de aplicação | % de CPU e RSS do processo Node.js durante o teste | `GET /metrics` (`process.cpuUsage()`), amostrado a cada 1 s pelo orquestrador |
| Uso de CPU/memória — banco de dados | % de CPU e memória da instância Postgres durante o teste | endpoint Prometheus do Supabase, amostrado a cada 5 s pelo orquestrador |
| Capacidade (ponto de saturação) | Maior taxa de chegada (req/s) sustentada com p95 ≤ 1 s, erro ≤ 1% e vazão ≥ 95% do alvo, e a concorrência correspondente (Lei de Little) | perfil `stress` do k6 (degraus de taxa de chegada), calculado por `npm run report` |

### 4.4 Variáveis controladas (constantes entre os grupos)

- Mesmo schema de dados e mesmo endpoint testado (mesma query lógica) nas duas APIs.
- Mesmo framework HTTP (Express) e mesma versão do Node.js.
- Mesmo hardware/tier de banco (mesmo projeto Supabase ou projetos com a mesma configuração).
- Mesmo perfil de carga do k6 (número de VUs, duração, ramp-up/ramp-down) aplicado às duas APIs, para cada volume de dados.
- Mesma distribuição dos dados de seed (mesmo gerador, mesma seed aleatória) entre RLS e Middleware.

## 5. Desenho experimental

Delineamento fatorial 2 × 3: **2 estratégias** (RLS, Middleware) × **3 volumes de dados** (10k, 50k, 100k) = **6 cenários**.

Cada cenário é executado com repetições (mínimo 3 execuções completas por cenário) para permitir cálculo de média, desvio padrão e verificar consistência dos resultados — execuções isoladas de teste de carga têm ruído (rede, cold start, GC do V8, autoscaling do Supabase).

```
                    │ 10.000 registros │ 50.000 registros │ 100.000 registros │
────────────────────┼───────────────────┼───────────────────┼────────────────────┤
RLS                 │   3+ execuções    │   3+ execuções    │    3+ execuções    │
Middleware          │   3+ execuções    │   3+ execuções    │    3+ execuções    │
```

## 6. Procedimento

Para cada cenário (estratégia × volume):

1. Popular o banco (schema isolado ou projeto Supabase isolado) com o volume de dados alvo, usando o mesmo gerador de dados/seed para garantir dados equivalentes entre RLS e Middleware.
2. Subir a API correspondente (`api-rls` ou `api-middleware`) e rodar `npm run check:equivalence` com as duas no ar: confirma que a regra de RBAC devolve os mesmos registros nas duas abordagens para o volume carregado. Se falhar, não coletar.
3. Aguardar um período de aquecimento (warm-up) fora da coleta, para estabilizar connection pooling e JIT do V8.
4. Executar o script k6 do cenário, com o perfil de carga padronizado (ver [`TESTES_DE_CARGA.md`](TESTES_DE_CARGA.md)).
5. Exportar a saída do k6 em JSON (`reports/json/`).
6. Registrar, no mesmo intervalo de tempo, as métricas de CPU do banco (Supabase) e da API.
7. Repetir 3+ vezes por cenário.
8. Consolidar todas as execuções em CSV (`reports/csv/`) para análise estatística.

## 7. Análise dos dados

- Estatística descritiva (média, mediana, desvio padrão, percentis) por cenário.
- Comparação da **taxa de degradação** (delta de latência/CPU entre 10k→50k→100k) de cada estratégia, não apenas o valor absoluto — é essa taxa que sustenta ou refuta H1.
- Comparação da **capacidade** (ponto de saturação, perfil `stress`) de cada estratégia em cada volume: quanto a capacidade cai de 10k→100k é a medida mais direta da sobrecarga do RLS sob concorrência.
- Visualização: gráficos de latência (p95) e CPU por volume de dados, uma linha por estratégia, para evidenciar a inclinação da curva de degradação.

## 8. Ameaças à validade

- **Ambiente compartilhado (Supabase multi-tenant/managed):** picos de uso de outros tenants na infraestrutura do Supabase podem introduzir ruído. Mitigação: múltiplas repetições, execução em horários variados, e (se necessário) uso de um tier dedicado.
- **Máquina/rede de onde o k6 é executado:** se o gerador de carga rodar na mesma máquina/rede da API, pode haver contenção de recursos mascarando o resultado. Recomendado rodar k6 e a API testada em ambientes separados da máquina local (ver decisão pendente em [`DECISOES_DE_PROJETO.md`](DECISOES_DE_PROJETO.md)).
- **Diferença de implementação não intencional:** se a query do Middleware fizer mais/menos trabalho do que a política de RLS equivalente (ex.: filtros diferentes, índices diferentes), o resultado deixa de refletir só a estratégia. Mitigação: revisão cruzada da lógica de autorização das duas APIs antes da coleta.
- **Latência de rede até o banco e nº de idas ao banco por requisição:** medido em 2026-09-26, da máquina do autor até o Supabase (us-east-1), o tempo de ida e volta é de ~133 ms. Na versão daquele piloto, a `api-rls` fazia 4 idas ao banco por requisição (`BEGIN`, `set_config`, query, `COMMIT`) e a `api-middleware` faz 2 (busca do usuário + query). Com API e banco distantes, 4 x 133 ms domina a latência (smoke test com 1 VU: RLS ~583 ms x Middleware ~315 ms) e a diferença medida reflete o **número de idas ao banco**, não o custo de aplicar RLS dentro do Postgres — que é o que a hipótese quer medir. Mitigação: rodar as APIs na mesma região do banco (RTT de poucos ms) e/ou igualar o nº de idas ao banco (ver decisão pendente em [`DECISOES_DE_PROJETO.md`](DECISOES_DE_PROJETO.md)). Os números do piloto local **não** servem como resultado. Desde 2026-11-03 o RLS faz 1 ida ao banco (decisão 9 em `DECISOES_DE_PROJETO.md`); a diferença residual (1 × 2 idas) é desprezível com a API na mesma região do banco, mas deve ser citada.
- **Cold start do Supabase/serverless:** se a API ou o banco tiverem cold start, a primeira execução de cada cenário pode distorcer a média. Mitigação: warm-up antes da coleta (passo 3 do procedimento).
