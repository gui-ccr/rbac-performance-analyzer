// Orquestra a coleta de UM volume de dados (os 2 cenários daquele volume).
//
//   npm run experiment -- --volume=10000 [--profile=stress|full] [--runs=3] [--only=rls|middleware]
//                         [--rls-url=...] [--mw-url=...] [--cooldown=60] [--skip-warmup]
//
// Pré-requisitos: as duas APIs no ar (ver docs/TESTES_DE_CARGA.md), o banco populado com
// `npm run seed -- --volume=N` e o k6 instalado. Para coletar a CPU do banco, defina
// SUPABASE_METRICS_KEY (e opcionalmente SUPABASE_PROJECT_REF) no `.env` da raiz.
//
// O que garante (docs/METODOLOGIA.md, seção 6):
//   1. Equivalência: `check:equivalence` precisa passar antes de qualquer medição.
//   2. Aquecimento (warm-up) de cada API, fora da coleta.
//   3. ORDEM ALTERNADA e contrabalançada: rodada 1 = RLS,Middleware; rodada 2 = Middleware,RLS; ...
//      Assim o ruído do Supabase (ambiente compartilhado, autoscaling) e a deriva ao longo do
//      tempo não favorecem sempre a mesma estratégia.
//   4. Intervalo (cooldown) entre execuções, para o banco/pool assentar.
//   5. CPU/memória da API (1 s) e do banco (5 s) amostradas durante cada execução.
//   6. Saída em reports/json/<base>.json.gz (k6 bruto), <base>-cpu-api.json, <base>-cpu-db.json,
//      onde <base> = <estrategia>-<N>k[-<perfil>]-run<R>, e um manifesto com os horários.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadDbMetricsConfig, readDbMetrics, startApiSampler, startDbSampler, type Sampler } from './samplers.js';

type Strategy = 'rls' | 'middleware';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function intArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value) || value < 0) fail(`--${name} deve ser um inteiro >= 0.`);
  return value;
}
function fail(message: string): never {
  console.error(`\n[experiment] ${message}`);
  process.exit(1);
}

const volume = intArg('volume', 0);
if (volume <= 0 || volume % 1000 !== 0) fail('--volume é obrigatório e deve ser múltiplo de 1000 (ex.: 10000).');
const runs = intArg('runs', 3);
if (runs < 1) fail('--runs deve ser >= 1.');
const cooldownS = intArg('cooldown', 60);
const profile = arg('profile', 'full') as string;
if (!['full', 'stress', 'smoke'].includes(profile)) fail('--profile deve ser full, stress ou smoke.');
const skipWarmup = process.argv.includes('--skip-warmup');
const only = arg('only') as Strategy | undefined;
if (only && only !== 'rls' && only !== 'middleware') fail('--only deve ser rls ou middleware.');
const strategies: Strategy[] = only ? [only] : ['rls', 'middleware'];
const urls: Record<Strategy, string> = {
  rls: arg('rls-url', 'http://localhost:3001') as string,
  middleware: arg('mw-url', 'http://localhost:3002') as string,
};
const k6Bin =
  process.env.K6_BIN ??
  (process.platform === 'win32' && existsSync('C:\\Program Files\\k6\\k6.exe') ? 'C:\\Program Files\\k6\\k6.exe' : 'k6');
const label = `${volume / 1000}k`;
const scenarioFile = (s: Strategy) => `load-tests/k6/${s}-${label}.js`;
const runBase = (s: Strategy, round: number) =>
  `reports/json/${s}-${label}${profile === 'full' ? '' : `-${profile}`}-run${round}`;

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

// --- pré-checagens -----------------------------------------------------------------
const k6Check = await run(k6Bin, ['version']).catch(() => 1);
if (k6Check !== 0) fail('k6 não encontrado. Instale (https://k6.io/docs/get-started/installation/) ou defina K6_BIN.');

for (const s of strategies) {
  if (!existsSync(scenarioFile(s))) fail(`Cenário ${scenarioFile(s)} não existe.`);
}

const usersFile = 'scripts/seed/output/test-users.json';
if (!existsSync(usersFile)) fail(`${usersFile} não existe. Rode: npm run seed -- --volume=${volume}`);
const seeded = JSON.parse(readFileSync(usersFile, 'utf8')) as { volume: number };
if (seeded.volume !== volume) fail(`O banco foi populado com ${seeded.volume} registros, não ${volume}. Rode: npm run seed -- --volume=${volume}`);

for (const s of ['rls', 'middleware'] as const) {
  const res = await fetch(`${urls[s]}/health`).catch(() => null);
  const body = res?.ok ? ((await res.json()) as { strategy?: string }) : null;
  if (body?.strategy !== s) fail(`${urls[s]}/health não respondeu como "${s}". A API está no ar e a URL está certa?`);
  const metrics = await fetch(`${urls[s]}/metrics`).catch(() => null);
  if (!metrics?.ok) fail(`${urls[s]}/metrics não respondeu. A API está atualizada (rode npm run build)?`);
}

let dbMetrics: ReturnType<typeof loadDbMetricsConfig> = null;
try {
  dbMetrics = loadDbMetricsConfig();
  if (dbMetrics) await readDbMetrics(dbMetrics);
} catch (err) {
  fail(`Não consegui ler as métricas do banco no Supabase: ${(err as Error).message}`);
}
console.log(`[experiment] volume=${volume} runs=${runs} profile=${profile} cooldown=${cooldownS}s estratégias=${strategies.join(',')}`);
console.log(`[experiment] rls=${urls.rls}  middleware=${urls.middleware}`);
console.log(
  dbMetrics
    ? '[experiment] CPU do banco: coletando via endpoint Prometheus do Supabase.'
    : '[experiment] AVISO: SUPABASE_METRICS_KEY ausente — CPU do banco NÃO será coletada.',
);

// --- 1. equivalência ----------------------------------------------------------------
console.log('\n[experiment] 1/3 checando equivalência entre as duas APIs...');
const eq = await run(process.execPath, [
  '--import', 'tsx', 'scripts/check/equivalence.ts', `--rls-url=${urls.rls}`, `--mw-url=${urls.middleware}`,
]);
if (eq !== 0) fail('As APIs devolvem resultados diferentes. Não coletar até corrigir (ver docs/POLITICAS_RLS.md).');

// --- 2. aquecimento -----------------------------------------------------------------
if (skipWarmup) {
  console.log('\n[experiment] 2/3 aquecimento PULADO (--skip-warmup) — não use isto na coleta oficial.');
} else {
  console.log('\n[experiment] 2/3 aquecimento (fora da coleta)...');
  for (const s of strategies) {
    // Exit 99 = threshold cruzado (aceitável no aquecimento); qualquer outro erro é problema real.
    const code = await run(k6Bin, ['run', '-e', `BASE_URL=${urls[s]}`, '-e', 'PROFILE=warmup', scenarioFile(s)]);
    if (code !== 0 && code !== 99) fail(`Aquecimento de ${s} falhou (k6 exit ${code}).`);
  }
}

// --- 3. coleta ------------------------------------------------------------------------
console.log('\n[experiment] 3/3 coleta (ordem alternada)...');
mkdirSync('reports/json', { recursive: true });
const manifestPath = `reports/json/manifest-${label}${profile === 'full' ? '' : `-${profile}`}.json`;
const manifest: unknown[] = [];
const problems: string[] = [];
// Parâmetros do stress que o k6 lê do ambiente: registrados no manifesto para reprodução.
const stressEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith('STRESS_') || k === 'REQ_TIMEOUT'),
);

for (let round = 1; round <= runs; round++) {
  const order: Strategy[] = round % 2 === 1 ? strategies : [...strategies].reverse();
  for (const s of order) {
    const base = runBase(s, round);
    const out = `${base}.json.gz`;
    console.log(`\n[experiment] >>> ${s} ${label} ${profile} run ${round}/${runs} -> ${out}`);

    const samplers: Sampler[] = [startApiSampler(urls[s], `${base}-cpu-api.json`)];
    if (dbMetrics) samplers.push(startDbSampler(dbMetrics, `${base}-cpu-db.json`));

    const startedAt = new Date().toISOString();
    const code = await run(k6Bin, [
      'run', '-e', `BASE_URL=${urls[s]}`, '-e', `PROFILE=${profile}`, '--out', `json=${out}`, scenarioFile(s),
    ]);
    const endedAt = new Date().toISOString();
    const [apiSamples, dbSamples] = await Promise.all(samplers.map((x) => x.stop()));

    manifest.push({
      strategy: s, volume, run: round, profile, file: out,
      cpuApiFile: `${base}-cpu-api.json`, cpuDbFile: dbMetrics ? `${base}-cpu-db.json` : null,
      apiSamples, dbSamples: dbSamples ?? 0, startedAt, endedAt, k6ExitCode: code, env: stressEnv,
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // No stress, exit 99 = trava de segurança (>50% de erro): saturação severa, resultado válido.
    const acceptable = code === 0 || (profile === 'stress' && code === 99);
    if (!acceptable) {
      problems.push(`${s} run ${round}: k6 exit ${code}${code === 99 ? ' (threshold cruzado)' : ''}`);
      console.warn(`[experiment] AVISO: k6 terminou com código ${code}. A execução ficou registrada no manifesto; revise antes de usar.`);
    } else if (code === 99) {
      console.warn('[experiment] stress interrompido pela trava de segurança (>50% de erro) — saturação severa atingida.');
    }
    const isLast = round === runs && s === order[order.length - 1];
    if (!isLast && cooldownS > 0) {
      console.log(`[experiment] cooldown de ${cooldownS}s...`);
      await sleep(cooldownS);
    }
  }
}

console.log(`\n[experiment] Concluído. Manifesto: ${manifestPath}`);
console.log('[experiment] Próximo passo: npm run report');
if (problems.length > 0) {
  console.warn('[experiment] Execuções com problema:\n  - ' + problems.join('\n  - '));
  process.exit(2);
}
