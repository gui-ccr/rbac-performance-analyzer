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
// load-tests/k6/base-scenario.js (esqueleto — a implementar)
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

## Coleta de CPU (fora do k6)

O k6 mede o lado do cliente (latência, throughput, erros). CPU precisa ser coletado à parte, na janela de tempo da execução:

- **API (Node.js):** endpoint `/metrics` expõe `process.cpuUsage()` amostrado a cada N segundos por um script simples, salvo em `reports/json/<run-id>-cpu-api.json`. Alternativa: `pidstat -p <pid> 1` redirecionado para arquivo, se a API rodar em uma VM com acesso de shell.
- **Banco (Supabase):** painel *Database → Reports* do Supabase mostra CPU % por período. Anotar o intervalo de início/fim de cada execução (o próprio k6 imprime isso ao final) para recortar a métrica correspondente. Se o plano do Supabase expuser métricas via Prometheus/API, preferir coleta automatizada a leitura manual do painel.

> Ponto em aberto: confirmar qual plano do Supabase será usado e qual nível de granularidade de métricas de CPU ele expõe — isso pode exigir ajuste neste documento. Ver [`DECISOES_DE_PROJETO.md`](DECISOES_DE_PROJETO.md).

## Pipeline de relatórios: JSON → CSV

1. k6 grava um `.json` por execução em `reports/json/` (uma linha NDJSON por ponto de métrica).
2. `scripts/report/` (a implementar) lê todos os `.json` de uma pasta, extrai as métricas relevantes (`http_req_duration` por percentil, `http_reqs`, `http_req_failed`) e os arquivos de CPU correspondentes.
3. Gera uma linha consolidada por execução em `reports/csv/resultados.csv`, com colunas:

```
estrategia,volume,run,p50_ms,p90_ms,p95_ms,p99_ms,throughput_rps,error_rate,cpu_api_avg,cpu_api_max,cpu_db_avg,cpu_db_max,timestamp_inicio,timestamp_fim
```

Esse CSV é o insumo direto para a análise estatística e os gráficos da seção de resultados da tese.
