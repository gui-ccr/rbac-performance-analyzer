# Testes de Carga

## Ferramenta

**k6** (Grafana Labs). Motivos:

- Scripts em JavaScript — mesma linguagem do resto do projeto.
- Métricas de latência (`http_req_duration`, com percentis), throughput e taxa de erro nativas, sem instrumentação manual.
- Saída estruturada em JSON (`--out json=arquivo.json`), uma linha por métrica coletada — inteiramente compatível com o pipeline "JSON bruto → CSV consolidado" definido para o projeto.
- Suporta cenários com estágios (`stages`), permitindo ramp-up/ramp-down padronizado entre os 6 cenários do experimento.

Instalação: https://k6.io/docs/get-started/installation/ (binário nativo, não é dependência do `package.json`).

## Perfil de carga padrão

O mesmo perfil é aplicado a **todos os 6 cenários** (2 estratégias × 3 volumes), para que o volume de dados e a estratégia sejam as únicas variáveis:

```js
// load-tests/k6/base-scenario.js (implementado; resumo dos estágios abaixo)
export const options = {
  stages: [
    { duration: '30s', target: 20 },   // ramp-up
    { duration: '2m',  target: 20 },   // carga sustentada
    { duration: '30s', target: 50 },   // pico
    { duration: '1m',  target: 50 },   // carga sustentada no pico
    { duration: '30s', target: 0 },    // ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};
```

> Os valores de VUs (usuários virtuais) e durações acima são um ponto de partida — devem ser calibrados com um teste piloto antes da coleta oficial, para garantir que o cenário de 100k registros não estoure timeouts a ponto de invalidar a comparação.

## Cenários

Um arquivo k6 por combinação, parametrizando apenas a URL base (`api-rls` vs `api-middleware`) e o volume de dados já carregado no banco:

```
load-tests/k6/
├── base-scenario.js        # perfil de carga compartilhado (import)
├── rls-10k.js
├── rls-50k.js
├── rls-100k.js
├── middleware-10k.js
├── middleware-50k.js
└── middleware-100k.js
```

Cada script:

1. Importa o perfil de carga base.
2. Define a `BASE_URL` da API alvo (via env var, ex. `k6 run -e BASE_URL=http://localhost:3001 rls-10k.js`).
3. Autentica um conjunto pequeno de usuários de teste (um por papel: `admin`, `manager`, `viewer`), reutilizando os mesmos tokens/JWTs entre execuções para não medir custo de login.
4. Executa `GET /records` com distribuição de papéis (ex.: 20% admin, 30% manager, 50% viewer) para simular uma carga realista de multi-tenant.

## Execução

```bash
# API precisa estar de pé e o banco populado com o volume correspondente
k6 run \
  -e BASE_URL=http://localhost:3001 \
  --out json=reports/json/rls-10k-run1.json \
  load-tests/k6/rls-10k.js
```

Convenção de nome do arquivo de saída: `<estrategia>-<volume>-run<N>.json` (ex. `middleware-100k-run3.json`) — o script de conversão para CSV depende desse padrão para extrair `estrategia`, `volume` e `run` automaticamente.

## Como rodar a coleta de um volume (implementado)

`npm run experiment -- --volume=10000` orquestra os 2 cenários daquele volume (`scripts/run/run-experiment.ts`):

1. confere que o k6 está instalado, que o banco foi populado com o volume pedido e que as duas APIs respondem como `rls` e `middleware`;
2. roda `npm run check:equivalence` — se falhar, **não coleta**;
3. aquece cada API (perfil `warmup`, 1 min, fora da coleta);
4. coleta `--runs` rodadas (padrão 3) com **ordem alternada e contrabalançada**: rodada 1 = RLS, Middleware; rodada 2 = Middleware, RLS; rodada 3 = RLS, Middleware. O ruído do Supabase e a deriva ao longo do tempo não favorecem sempre a mesma estratégia;
5. espera `--cooldown` segundos (padrão 60) entre execuções;
6. amostra CPU/memória da API e do banco durante cada execução (ver "Coleta de CPU e memória");
7. grava `reports/json/<estrategia>-<N>k[-<perfil>]-run<R>.json.gz` (saída bruta do k6, compactada), os arquivos `-cpu-api.json`/`-cpu-db.json` e `reports/json/manifest-<N>k[-<perfil>].json` com início/fim e parâmetros de cada execução.

`--only=rls|middleware` roda uma só estratégia (útil para pilotos; na coleta oficial, rode as duas juntas para manter o contrabalanceamento).

Só uma API recebe carga por vez. Para trocar de volume: `npm run seed -- --volume=N`, atualizar `DATA_VOLUME` nos `.env` e rodar o experimento de novo. Um cenário aborta se o banco estiver com outro volume que o do arquivo (`rls-50k.js` com o banco em 10k).

### O que o script k6 garante

- **Mesmo perfil, mesmos usuários, mesma sequência de papéis** nos 6 cenários. A distribuição 20% admin / 30% manager / 50% viewer é exata e determinística (ciclos de 10 requisições, sem `Math.random`).
- **Setup falha cedo:** `/health` precisa responder com a estratégia do cenário (evita apontar `rls-*.js` para a API de middleware) e cada usuário de teste precisa receber exatamente o nº de registros que o seed diz.
- **Resultado conferido durante a carga:** cada resposta é comparada com o nº esperado de registros (métrica `wrong_result`; qualquer ocorrência **aborta** a execução). Sob concorrência, isso pega RLS ignorado e identidade vazando entre requisições que reaproveitam a conexão.
- **Tags** em todos os pontos do JSON bruto: `strategy`, `volume`, `role` e `phase`. As requisições de setup têm `phase=setup` e devem ser **descartadas** pelo script de relatório (só `phase=load` entra na análise). Assim é possível reportar latência por papel.
- Perfis (`-e PROFILE=`): `full` (coleta oficial), `warmup`, `smoke` (10 s, 1 VU, só para ver que roda). O tamanho da página é `PAGE_SIZE=50`, igual nos 6 cenários.

## Perfil `stress`: ponto de saturação (etapas 1 e 2)

O perfil `full` aplica carga fixa (20 → 50 VUs) e mede latência **sob uma carga conhecida**. Para achar o **limite** de cada abordagem (quantas requisições/usuários simultâneos ela aguenta antes de degradar), existe o perfil `stress`:

```bash
npm run experiment -- --volume=10000 --profile=stress            # RLS e Middleware, ordem alternada
STRESS_STEP_RPS=20 STRESS_STEPS=15 npm run experiment -- --volume=10000 --profile=stress
```

- **Modelo aberto** (`ramping-arrival-rate`): a taxa de chegada sobe em degraus fixos, independentemente de o servidor dar conta. No modelo fechado (VUs fixos), um servidor lento "freia" o gerador e a saturação fica escondida.
- **Degraus:** começa em `STRESS_START_RPS` (10) e sobe `STRESS_STEP_RPS` (10) a cada `STRESS_STEP_S` (60 s), por `STRESS_STEPS` (12) degraus. Os primeiros `STRESS_SETTLE_S` (5 s) de cada degrau ficam com `phase=transition` e são descartados. Até `STRESS_MAX_VUS` (500) VUs; timeout por requisição de 10 s (`REQ_TIMEOUT`).
- **Tags** `step` e `target_rps` em cada requisição, para a análise por degrau.
- **Thresholds:** `wrong_result` continua abortando (correção dos dados). Latência e erro não são metas no stress (cruzá-las é o objetivo); há só uma trava de segurança que interrompe a execução com mais de 50% de erro depois de 1 min (exit 99, aceito pelo orquestrador como "saturação severa").
- `wrong_result` conta só respostas **200 com conteúdo errado**. Erros HTTP e timeouts são falha de capacidade e entram em `http_req_failed`.
- **Calibração:** rodar um piloto (`--runs=1`) e ajustar `STRESS_STEP_RPS`/`STRESS_STEPS` até a saturação cair no meio da escada. Os mesmos parâmetros valem depois para os 6 cenários (ficam registrados no manifesto, campo `env`).

### Critério de saturação

Calculado por degrau em `npm run report` (parâmetros `--slo-p95`, `--max-error`, `--min-throughput`). Um degrau **passa** se:

- p95 ≤ 1000 ms, **e**
- taxa de erro ≤ 1%, **e**
- vazão obtida ≥ 95% da taxa-alvo.

**Capacidade** = taxa-alvo do último degrau que passou antes do primeiro que falhou. **Usuários simultâneos na capacidade** = vazão × latência média (Lei de Little): o nº médio de requisições em atendimento ao mesmo tempo. Como num modelo aberto a fila explode logo depois da saturação, o resultado é pouco sensível ao valor exato do SLO.

## Coleta de CPU e memória (implementado)

O k6 mede o lado do cliente. CPU e memória são amostradas pelo orquestrador **durante** cada execução (`scripts/run/samplers.ts`) e gravadas ao lado do JSON do k6:

- **API (Node.js):** `GET /metrics` (igual nas duas APIs, `packages/shared/src/metrics.ts`) devolve contadores cumulativos de `process.cpuUsage()`, tempo de parede e RSS. Leitura a cada 1 s → `<base>-cpu-api.json`. CPU % = Δ(user+system)/Δ(parede) × 100 (100% = 1 núcleo).
- **Banco (Supabase):** endpoint Prometheus do projeto (`https://<ref>.supabase.co/customer/v1/privileged/metrics`, autenticação básica `service_role:<chave>`), lido a cada 5 s → `<base>-cpu-db.json`. CPU % = 1 − Δ(idle+iowait)/Δ(total) de `node_cpu_seconds_total`; memória = 1 − MemAvailable/MemTotal. Para ativar, coloque no `.env` da raiz:

```
SUPABASE_METRICS_KEY=<service_role key ou secret key do projeto>
# SUPABASE_PROJECT_REF=<ref>   # opcional: é deduzido do usuário do pooler em apps/api-rls/.env
```

  Sem a chave, o orquestrador avisa e as colunas de CPU do banco ficam vazias. Com a chave, ele faz uma leitura de teste antes de começar e aborta se falhar.

O relatório recorta as amostras pela janela exata de cada execução (e de cada degrau, no stress).

## Pipeline de relatórios: JSON → CSV (implementado)

`npm run report` (`scripts/report/build-csv.ts`) lê os manifestos `reports/json/manifest-*.json`, abre o JSON bruto (`.json.gz`) e os arquivos de CPU de cada execução, descarta tudo que não é `phase=load` e grava em `reports/csv/`:

| Arquivo | Linha = | Conteúdo |
|---|---|---|
| `resultados.csv` | execução | p50/p90/p95/p99, média, p95 por papel, throughput, taxa de erro, CPU/memória da API e do banco |
| `stress-degraus.csv` | degrau de cada execução de stress | alvo × vazão obtida, percentis, erro, `dropped_iterations`, VUs, concorrência (Little), CPU, passou/motivo |
| `saturacao.csv` | execução de stress | capacidade (req/s), p95 e concorrência na capacidade, degrau e motivo da saturação |
| `resumo.csv` | estratégia × volume × perfil | média e desvio-padrão entre as rodadas |

Esses CSVs são o insumo direto para a análise estatística e os gráficos da tese.
