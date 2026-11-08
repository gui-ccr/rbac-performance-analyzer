// Perfil de carga e lógica compartilhados pelos 6 cenários (2 estratégias x 3 volumes).
// Cada cenário (rls-10k.js, middleware-50k.js, ...) só informa `strategy` e `volume`;
// todo o resto é IDÊNTICO entre eles, para que estratégia e volume sejam as únicas
// variáveis (docs/METODOLOGIA.md, variáveis controladas).
//
// Variáveis de ambiente (k6 run -e NOME=valor):
//   BASE_URL      URL da API alvo (padrão: localhost:3001 p/ rls, :3002 p/ middleware)
//   PROFILE       full (padrão, carga fixa) | stress (etapa 1/2: degraus até saturar)
//                 | warmup | smoke (só verificar que roda)
//   PAGE_SIZE     tamanho da página de GET /records (padrão 50 — igual nos 6 cenários)
//   THINK_TIME_S  pausa entre requisições de cada VU, em segundos (padrão 0; ignorado no stress)
//   REQ_TIMEOUT   timeout de cada requisição (padrão 60s; 10s no stress)
//
// Perfil stress (modelo ABERTO, executor ramping-arrival-rate): a taxa de chegada sobe em
// degraus fixos, independentemente de o servidor dar conta. Num modelo fechado (VUs fixos)
// o servidor lento "freia" o gerador e a saturação fica escondida. Cada degrau dura
// STRESS_STEP_S segundos; os primeiros STRESS_SETTLE_S de cada degrau recebem phase=transition
// e são descartados na análise. O ponto de saturação é calculado depois, por degrau,
// em scripts/report/build-csv.ts.
//   STRESS_START_RPS  (padrão 10)  STRESS_STEP_RPS (10)  STRESS_STEPS (12)
//   STRESS_STEP_S     (60)         STRESS_SETTLE_S (5)   STRESS_MAX_VUS (500)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import exec from 'k6/execution';

const USERS_FILE = '../../scripts/seed/output/test-users.json';
const DEFAULT_URLS = { rls: 'http://localhost:3001', middleware: 'http://localhost:3002' };

// Perfil oficial (docs/TESTES_DE_CARGA.md). Ponto de partida: calibrar com um teste
// piloto antes da coleta, e só então congelar — o MESMO perfil vale para os 6 cenários.
const PROFILES = {
  full: [
    { duration: '30s', target: 20 }, // ramp-up
    { duration: '2m', target: 20 }, // carga sustentada
    { duration: '30s', target: 50 }, // pico
    { duration: '1m', target: 50 }, // carga sustentada no pico
    { duration: '30s', target: 0 }, // ramp-down
  ],
  warmup: [
    { duration: '20s', target: 10 },
    { duration: '40s', target: 10 },
  ],
  smoke: [{ duration: '10s', target: 1 }],
};

// 20% admin, 30% manager, 50% viewer, em ciclos de 10 requisições (determinístico e
// exato, sem Math.random: os dois cenários recebem exatamente a mesma sequência de papéis).
const ROLE_SLOTS = ['admin', 'admin', 'manager', 'manager', 'manager', 'viewer', 'viewer', 'viewer', 'viewer', 'viewer'];
const ROLES = ['admin', 'manager', 'viewer'];

// Um resultado errado (contagem diferente da esperada) invalida a execução: sob
// concorrência, pode indicar RLS ignorado ou identidade vazando entre requisições.
const wrongResult = new Rate('wrong_result');

export function createScenario({ strategy, volume }) {
  const baseUrl = __ENV.BASE_URL || DEFAULT_URLS[strategy];
  const profile = __ENV.PROFILE || 'full';
  const pageSize = Number(__ENV.PAGE_SIZE || 50);
  const thinkTime = Number(__ENV.THINK_TIME_S || 0);

  if (!PROFILES[profile] && profile !== 'stress') {
    throw new Error(`PROFILE inválido: "${profile}" (use stress | ${Object.keys(PROFILES).join(' | ')}).`);
  }
  if (!baseUrl) throw new Error(`Estratégia desconhecida: "${strategy}".`);

  // Usuários de teste gerados pelo seed (com token e nº esperado de registros visíveis).
  const usersFile = JSON.parse(open(USERS_FILE));
  if (usersFile.volume !== volume) {
    throw new Error(
      `Este cenário é de ${volume} registros, mas o banco foi populado com ${usersFile.volume} ` +
        `(${USERS_FILE}). Rode: npm run seed -- --volume=${volume}`,
    );
  }
  const byRole = {};
  for (const role of ROLES) {
    byRole[role] = usersFile.users.filter((u) => u.role === role);
    if (byRole[role].length === 0) throw new Error(`Nenhum usuário "${role}" em ${USERS_FILE}.`);
  }

  const submetrics = {};
  for (const role of ROLES) submetrics[`http_req_duration{role:${role}}`] = ['max>=0']; // sem limite: só cria a série por papel

  const isStress = profile === 'stress';
  const reqTimeout = __ENV.REQ_TIMEOUT || (isStress ? '10s' : '60s');
  const stress = {
    startRps: Number(__ENV.STRESS_START_RPS || 10),
    stepRps: Number(__ENV.STRESS_STEP_RPS || 10),
    steps: Number(__ENV.STRESS_STEPS || 12),
    stepS: Number(__ENV.STRESS_STEP_S || 60),
    settleS: Number(__ENV.STRESS_SETTLE_S || 5),
    maxVus: Number(__ENV.STRESS_MAX_VUS || 500),
  };
  const stepTarget = (i) => stress.startRps + i * stress.stepRps;

  // Correção dos dados aborta a execução em qualquer perfil (wrong_result). As metas de
  // latência/erro só valem para a carga fixa: no stress, cruzá-las é justamente o objetivo,
  // então ali há só uma trava de segurança (>50% de erro depois de 1 min).
  const thresholds = isStress
    ? {
        wrong_result: [{ threshold: 'rate==0', abortOnFail: true }],
        http_req_failed: [{ threshold: 'rate<0.5', abortOnFail: true, delayAbortEval: '60s' }],
        ...submetrics,
      }
    : {
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<2000'],
        wrong_result: [{ threshold: 'rate==0', abortOnFail: true }],
        ...submetrics,
      };

  const options = {
    // Tags em todas as métricas (aparecem no JSON bruto): permitem agrupar por estratégia/volume/papel.
    tags: { strategy, volume: String(volume), profile },
    // Só as tags de sistema úteis à análise: reduz bastante o tamanho do JSON bruto.
    systemTags: ['status', 'method', 'scenario', 'expected_response', 'error_code', 'check'],
    thresholds,
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  };

  if (isStress) {
    const stages = [];
    for (let i = 0; i < stress.steps; i++) {
      stages.push({ duration: '1s', target: stepTarget(i) }, { duration: `${stress.stepS - 1}s`, target: stepTarget(i) });
    }
    options.scenarios = {
      stress: {
        executor: 'ramping-arrival-rate',
        startRate: stress.startRps,
        timeUnit: '1s',
        preAllocatedVUs: Math.min(50, stress.maxVus),
        maxVUs: stress.maxVus,
        stages,
      },
    };
  } else {
    options.stages = PROFILES[profile];
  }

  const listUrl = `${baseUrl}/records?page=1&pageSize=${pageSize}`;
  const authHeaders = (user) => ({ Authorization: `Bearer ${user.token}` });
  const expectedRows = (user) => Math.min(user.expectedRecords, pageSize);

  function resultIsCorrect(res, user) {
    if (res.status !== 200) return false;
    try {
      return res.json('data').length === expectedRows(user);
    } catch (_) {
      return false;
    }
  }

  // Roda uma vez antes da carga: falha cedo se o ambiente não é o que o cenário afirma.
  function setup() {
    const startedAt = new Date().toISOString();

    const health = http.get(`${baseUrl}/health`, { tags: { phase: 'setup' } });
    if (health.status !== 200 || health.json('strategy') !== strategy) {
      throw new Error(
        `${baseUrl}/health não respondeu como "${strategy}" (HTTP ${health.status}: ${health.body}). ` +
          'A URL aponta para a API errada, ou a API está fora do ar.',
      );
    }

    // Cada usuário de teste deve receber exatamente o que o seed diz que ele enxerga.
    // (Requisições de setup têm a tag phase=setup para serem descartadas na análise.)
    for (const user of usersFile.users) {
      const res = http.get(listUrl, { headers: authHeaders(user), tags: { phase: 'setup' } });
      if (!resultIsCorrect(res, user)) {
        throw new Error(
          `Pré-checagem falhou para ${user.role} ${user.email}: HTTP ${res.status}, ` +
            `esperado ${expectedRows(user)} registro(s). Rode: npm run check:equivalence`,
        );
      }
    }

    return { startedAt };
  }

  function run() {
    const i = exec.scenario.iterationInTest;
    const role = ROLE_SLOTS[i % ROLE_SLOTS.length];
    const pool = byRole[role];
    const user = pool[Math.floor(i / ROLE_SLOTS.length) % pool.length];

    const tags = { role, phase: 'load' };
    if (isStress) {
      // Degrau atual pelo tempo decorrido do cenário (os degraus têm duração fixa).
      const elapsedMs = Date.now() - exec.scenario.startTime;
      const step = Math.min(Math.floor(elapsedMs / (stress.stepS * 1000)), stress.steps - 1);
      tags.step = String(step);
      tags.target_rps = String(stepTarget(step));
      if (elapsedMs - step * stress.stepS * 1000 < stress.settleS * 1000) tags.phase = 'transition';
    }

    const res = http.get(listUrl, { headers: authHeaders(user), tags, timeout: reqTimeout });

    // wrong_result = resposta 200 com conteúdo errado (RLS ignorado, identidade vazando).
    // Erros HTTP/timeouts NÃO entram aqui: são falhas de capacidade, medidas em http_req_failed.
    const ok = resultIsCorrect(res, user);
    if (res.status === 200) wrongResult.add(!ok, { role });
    check(res, { 'status 200 e resultado esperado': () => ok });

    if (thinkTime > 0 && !isStress) sleep(thinkTime);
  }

  function teardown(data) {
    // Janela de tempo da execução, para cruzar com a CPU do banco no painel do Supabase.
    console.log(`[janela] ${strategy} ${volume}: ${data.startedAt} -> ${new Date().toISOString()} (UTC)`);
  }

  return { options, setup, run, teardown };
}
