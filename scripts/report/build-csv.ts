// Consolida a saída bruta das execuções em CSVs para a análise (docs/TESTES_DE_CARGA.md,
// "Pipeline de relatórios").
//
//   npm run report -- [--dir=reports/json] [--out=reports/csv] [--slo-p95=1000] [--max-error=0.01] [--min-throughput=0.95]
//
// Fonte: os manifestos reports/json/manifest-*.json gravados por `npm run experiment`
// (cada entrada aponta para o JSON bruto do k6 e para os arquivos de CPU daquela execução).
// Só pontos com phase=load entram (setup e transições entre degraus são descartados).
//
// Saídas em reports/csv/:
//   resultados.csv       uma linha por execução (latência, throughput, erro, CPU/memória)
//   stress-degraus.csv   uma linha por degrau de cada execução de stress
//   saturacao.csv        ponto de saturação de cada execução de stress
//   resumo.csv           média e desvio-padrão entre as rodadas, por estratégia x volume x perfil
//
// Critério de saturação (por degrau; parâmetros acima): o degrau PASSA se
//   p95 <= --slo-p95 ms  E  taxa de erro <= --max-error  E  vazão obtida >= --min-throughput x alvo.
// Capacidade = alvo (req/s) do último degrau que passou antes do primeiro que falhou.
// Concorrência na capacidade = vazão x latência média (Lei de Little): nº médio de
// requisições simultâneas em atendimento — os "usuários simultâneos" que o sistema sustenta.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { ApiSample, DbSample } from '../run/samplers.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const dir = arg('dir', 'reports/json');
const outDir = arg('out', 'reports/csv');
const sloP95 = Number(arg('slo-p95', '1000'));
const maxError = Number(arg('max-error', '0.01'));
const minThroughput = Number(arg('min-throughput', '0.95'));

interface ManifestEntry {
  strategy: string;
  volume: number;
  run: number;
  profile: string;
  file: string;
  cpuApiFile?: string | null;
  cpuDbFile?: string | null;
  startedAt: string;
  endedAt: string;
  k6ExitCode: number;
  env?: Record<string, string>;
}

interface Bucket {
  durations: number[];
  roles: Record<string, number[]>;
  reqs: number;
  failed: number;
  firstMs: number;
  lastMs: number;
}
const newBucket = (): Bucket => ({ durations: [], roles: {}, reqs: 0, failed: 0, firstMs: Infinity, lastMs: -Infinity });

interface StepInfo {
  bucket: Bucket;
  target: number;
  winStart: number; // janela do degrau (todas as fases), para atribuir vus/dropped por tempo
  winEnd: number;
  dropped: number;
  vusMax: number;
}

// --- estatística ----------------------------------------------------------------------
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length); // nearest-rank
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const round = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '' : x.toFixed(d));

// --- leitura do k6 --------------------------------------------------------------------
async function parseK6(file: string) {
  const input = createReadStream(file);
  const stream = file.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const all = newBucket();
  const steps = new Map<number, StepInfo>();
  const timed: { metric: 'vus' | 'dropped_iterations'; t: number; v: number }[] = [];

  for await (const line of rl) {
    if (!line.startsWith('{"metric"') && !line.startsWith('{"type":"Point"')) continue;
    const pt = JSON.parse(line) as { type: string; metric: string; data: { time: string; value: number; tags?: Record<string, string> } };
    if (pt.type !== 'Point') continue;
    const { metric } = pt;
    const t = Date.parse(pt.data.time);
    const tags = pt.data.tags ?? {};

    if (metric === 'vus' || metric === 'dropped_iterations') {
      timed.push({ metric, t, v: pt.data.value });
      continue;
    }
    if (metric !== 'http_req_duration' && metric !== 'http_req_failed' && metric !== 'http_reqs') continue;

    let step: StepInfo | undefined;
    if (tags.step !== undefined) {
      const n = Number(tags.step);
      step = steps.get(n);
      if (!step) {
        step = { bucket: newBucket(), target: Number(tags.target_rps), winStart: t, winEnd: t, dropped: 0, vusMax: 0 };
        steps.set(n, step);
      }
      step.winStart = Math.min(step.winStart, t);
      step.winEnd = Math.max(step.winEnd, t);
    }
    if (tags.phase !== 'load') continue;

    for (const b of step ? [all, step.bucket] : [all]) {
      if (metric === 'http_req_duration') {
        b.durations.push(pt.data.value);
        (b.roles[tags.role ?? '?'] ??= []).push(pt.data.value);
      } else if (metric === 'http_req_failed') {
        if (pt.data.value) b.failed++;
      } else {
        b.reqs++;
        b.firstMs = Math.min(b.firstMs, t);
        b.lastMs = Math.max(b.lastMs, t);
      }
    }
  }

  for (const { metric, t, v } of timed) {
    for (const s of steps.values()) {
      if (t < s.winStart || t > s.winEnd) continue;
      if (metric === 'dropped_iterations') s.dropped += v;
      else s.vusMax = Math.max(s.vusMax, v);
    }
  }
  return { all, steps };
}

// --- CPU / memória ----------------------------------------------------------------------
function loadSamples<T extends { t: string }>(file: string | null | undefined): T[] {
  if (!file || !existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as { samples: T[] }).samples;
}
const inWindow = <T extends { t: string }>(xs: T[], a: number, b: number) =>
  xs.filter((x) => {
    const t = Date.parse(x.t);
    return t >= a && t <= b;
  });

function apiCpu(samples: ApiSample[], a: number, b: number) {
  const xs = inWindow(samples, a, b);
  const pcts: number[] = [];
  let busy = 0;
  let wall = 0;
  for (let i = 1; i < xs.length; i++) {
    const p = xs[i - 1]!;
    const c = xs[i]!;
    if (c.pid !== p.pid) continue; // API reiniciou no meio: descarta o intervalo
    const dCpu = c.cpuUserUs + c.cpuSystemUs - (p.cpuUserUs + p.cpuSystemUs);
    const dWall = c.wallTimeUs - p.wallTimeUs;
    if (dWall <= 0) continue;
    pcts.push((dCpu / dWall) * 100);
    busy += dCpu;
    wall += dWall;
  }
  return {
    avg: wall > 0 ? (busy / wall) * 100 : null,
    max: pcts.length ? Math.max(...pcts) : null,
    rssMaxMb: xs.length ? Math.max(...xs.map((x) => x.rssBytes)) / 1024 / 1024 : null,
  };
}

function dbCpu(samples: DbSample[], a: number, b: number) {
  const xs = inWindow(samples, a, b);
  const pcts: number[] = [];
  let busy = 0;
  let total = 0;
  for (let i = 1; i < xs.length; i++) {
    const p = xs[i - 1]!;
    const c = xs[i]!;
    const dTotal = c.cpuTotalS - p.cpuTotalS;
    const dIdle = c.cpuIdleS - p.cpuIdleS;
    if (dTotal <= 0) continue;
    pcts.push((1 - dIdle / dTotal) * 100);
    busy += dTotal - dIdle;
    total += dTotal;
  }
  const mem = xs
    .filter((x) => x.memTotalBytes && x.memAvailableBytes !== null)
    .map((x) => (1 - x.memAvailableBytes! / x.memTotalBytes!) * 100);
  return { avg: total > 0 ? (busy / total) * 100 : null, max: pcts.length ? Math.max(...pcts) : null, memAvgPct: mean(mem) };
}

// --- CSV --------------------------------------------------------------------------------
function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))].join('\n') + '\n';
}

// --- main -------------------------------------------------------------------------------
const manifests = existsSync(dir) ? readdirSync(dir).filter((f) => /^manifest-.*\.json$/.test(f)) : [];
if (manifests.length === 0) {
  console.error(`[report] Nenhum manifesto em ${dir}. Rode antes: npm run experiment -- --volume=N`);
  process.exit(1);
}
const entries = manifests.flatMap((m) => JSON.parse(readFileSync(`${dir}/${m}`, 'utf8')) as ManifestEntry[]);

const resultados: Record<string, string | number>[] = [];
const degraus: Record<string, string | number>[] = [];
const saturacao: Record<string, string | number>[] = [];

for (const e of entries.sort((x, y) => x.volume - y.volume || x.profile.localeCompare(y.profile) || x.run - y.run || x.strategy.localeCompare(y.strategy))) {
  if (!existsSync(e.file)) {
    console.warn(`[report] ${e.file} não existe — pulando.`);
    continue;
  }
  process.stdout.write(`[report] ${e.file} ... `);
  const { all, steps } = await parseK6(e.file);
  const apiSamples = loadSamples<ApiSample>(e.cpuApiFile);
  const dbSamples = loadSamples<DbSample>(e.cpuDbFile);
  const sorted = [...all.durations].sort((a, b) => a - b);
  const durS = (all.lastMs - all.firstMs) / 1000;
  const api = apiCpu(apiSamples, all.firstMs, all.lastMs);
  const db = dbCpu(dbSamples, all.firstMs, all.lastMs);
  const p95Role = (r: string) => round(percentile([...(all.roles[r] ?? [])].sort((a, b) => a - b), 95));

  resultados.push({
    estrategia: e.strategy, volume: e.volume, perfil: e.profile, run: e.run,
    requisicoes: all.reqs,
    p50_ms: round(percentile(sorted, 50)), p90_ms: round(percentile(sorted, 90)),
    p95_ms: round(percentile(sorted, 95)), p99_ms: round(percentile(sorted, 99)),
    media_ms: round(mean(all.durations)),
    p95_admin_ms: p95Role('admin'), p95_manager_ms: p95Role('manager'), p95_viewer_ms: p95Role('viewer'),
    throughput_rps: round(durS > 0 ? all.reqs / durS : null),
    error_rate: round(all.reqs ? all.failed / all.reqs : null, 4),
    cpu_api_avg: round(api.avg), cpu_api_max: round(api.max), mem_api_max_mb: round(api.rssMaxMb, 1),
    cpu_db_avg: round(db.avg), cpu_db_max: round(db.max), mem_db_avg_pct: round(db.memAvgPct),
    k6_exit: e.k6ExitCode,
    timestamp_inicio: new Date(all.firstMs).toISOString(), timestamp_fim: new Date(all.lastMs).toISOString(),
  });

  if (e.profile === 'stress') {
    let capacity: StepRow | null = null;
    let saturatedAt: StepRow | null = null;
    type StepRow = { step: number; target: number; achieved: number; p95: number | null; meanMs: number | null; err: number; reason: string };

    for (const [n, s] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
      const b = s.bucket;
      const ds = [...b.durations].sort((x, y) => x - y);
      const span = (b.lastMs - b.firstMs) / 1000;
      const achieved = span > 0 ? b.reqs / span : 0;
      const err = b.reqs ? b.failed / b.reqs : 1;
      const p95 = percentile(ds, 95);
      const meanMs = mean(b.durations);
      const reasons: string[] = [];
      if (p95 === null || p95 > sloP95) reasons.push(`p95>${sloP95}ms`);
      if (err > maxError) reasons.push(`erro>${maxError * 100}%`);
      if (achieved < minThroughput * s.target) reasons.push(`vazao<${minThroughput * 100}%`);
      const sapi = apiCpu(apiSamples, b.firstMs, b.lastMs);
      const sdb = dbCpu(dbSamples, b.firstMs, b.lastMs);

      degraus.push({
        estrategia: e.strategy, volume: e.volume, run: e.run, degrau: n, alvo_rps: s.target,
        vazao_rps: round(achieved), requisicoes: b.reqs,
        p50_ms: round(percentile(ds, 50)), p95_ms: round(p95), p99_ms: round(percentile(ds, 99)), media_ms: round(meanMs),
        error_rate: round(err, 4), dropped_iterations: s.dropped, vus_max: s.vusMax,
        concorrencia_little: round(meanMs !== null ? achieved * (meanMs / 1000) : null),
        cpu_api_avg: round(sapi.avg), cpu_db_avg: round(sdb.avg),
        passou: reasons.length === 0 ? 'sim' : 'nao', motivo: reasons.join(' '),
      });

      const row: StepRow = { step: n, target: s.target, achieved, p95, meanMs, err, reason: reasons.join(' ') };
      if (saturatedAt) continue;
      if (reasons.length === 0) capacity = row;
      else saturatedAt = row;
    }

    saturacao.push({
      estrategia: e.strategy, volume: e.volume, run: e.run,
      capacidade_rps: capacity ? capacity.target : 0,
      vazao_na_capacidade_rps: round(capacity?.achieved),
      p95_na_capacidade_ms: round(capacity?.p95),
      concorrencia_na_capacidade: round(capacity && capacity.meanMs !== null ? capacity.achieved * (capacity.meanMs / 1000) : null),
      degrau_saturacao: saturatedAt ? saturatedAt.step : '',
      alvo_saturacao_rps: saturatedAt ? saturatedAt.target : '',
      motivo_saturacao: saturatedAt ? saturatedAt.reason : 'NAO SATUROU (aumente STRESS_STEPS/STRESS_STEP_RPS)',
      criterio: `p95<=${sloP95}ms; erro<=${maxError}; vazao>=${minThroughput}*alvo`,
    });
  }
  console.log(`ok (${all.reqs} req)`);
}

// Resumo entre rodadas.
const groups = new Map<string, Record<string, string | number>[]>();
for (const r of resultados) {
  const key = `${r.estrategia}|${r.volume}|${r.perfil}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
}
const num = (rows: Record<string, string | number>[], col: string) =>
  rows.filter((r) => r[col] !== '').map((r) => Number(r[col])).filter(Number.isFinite);
const resumo = [...groups.entries()].map(([key, rows]) => {
  const [estrategia, volume, perfil] = key.split('|');
  const sat = saturacao.filter((s) => s.estrategia === estrategia && String(s.volume) === volume);
  const out: Record<string, string | number> = { estrategia: estrategia!, volume: volume!, perfil: perfil!, rodadas: rows.length };
  for (const col of ['p50_ms', 'p95_ms', 'p99_ms', 'throughput_rps', 'error_rate', 'cpu_api_avg', 'cpu_db_avg']) {
    out[`${col}_media`] = round(mean(num(rows, col)));
    out[`${col}_dp`] = round(stdev(num(rows, col)));
  }
  if (perfil === 'stress') {
    out.capacidade_rps_media = round(mean(num(sat, 'capacidade_rps')));
    out.capacidade_rps_dp = round(stdev(num(sat, 'capacidade_rps')));
    out.concorrencia_media = round(mean(num(sat, 'concorrencia_na_capacidade')));
  }
  return out;
});

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/resultados.csv`, toCsv(resultados));
writeFileSync(`${outDir}/resumo.csv`, toCsv(resumo));
if (degraus.length) writeFileSync(`${outDir}/stress-degraus.csv`, toCsv(degraus));
if (saturacao.length) writeFileSync(`${outDir}/saturacao.csv`, toCsv(saturacao));
console.log(`\n[report] Gravado em ${outDir}/: resultados.csv, resumo.csv${degraus.length ? ', stress-degraus.csv, saturacao.csv' : ''}`);
if (saturacao.length) console.table(saturacao.map(({ criterio: _c, ...r }) => r));
