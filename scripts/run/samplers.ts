// Coletores de uso de hardware durante uma execução do k6 (docs/TESTES_DE_CARGA.md,
// "Coleta de CPU e memória"). Gravam leituras CUMULATIVAS cruas com timestamp; o
// cálculo de % por janela fica no script de relatório (scripts/report/build-csv.ts).
//
//   API:   GET <api>/metrics (process.cpuUsage) a cada 1 s.
//   Banco: endpoint Prometheus do Supabase a cada 5 s (opcional — precisa de
//          SUPABASE_METRICS_KEY; sem ela, a CPU do banco não é coletada e o relatório
//          deixa as colunas vazias).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface ApiSample {
  t: string; // ISO, relógio do coletor
  wallTimeUs: number;
  cpuUserUs: number;
  cpuSystemUs: number;
  rssBytes: number;
  pid: number;
}

export interface DbSample {
  t: string;
  cpuTotalS: number; // soma de node_cpu_seconds_total (todos os modos, todos os núcleos)
  cpuIdleS: number; // modos idle + iowait
  cpuCount: number;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
}

export interface Sampler {
  stop(): Promise<number>; // grava o arquivo e devolve o nº de leituras
}

function startLoop<T>(intervalMs: number, read: () => Promise<T | null>, outFile: string): Sampler {
  const samples: T[] = [];
  let stopped = false;
  let errors = 0;
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const s = await read();
        if (s) samples.push(s);
      } catch {
        errors++;
      }
      const wait = intervalMs - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      // Uma última leitura fecha a janela exatamente no fim da execução.
      try {
        const s = await read();
        if (s) samples.push(s);
      } catch {
        errors++;
      }
      writeFileSync(outFile, JSON.stringify({ intervalMs, errors, samples }, null, 0));
      return samples.length;
    },
  };
}

export function startApiSampler(baseUrl: string, outFile: string, intervalMs = 1000): Sampler {
  return startLoop<ApiSample>(
    intervalMs,
    async () => {
      const res = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(intervalMs * 2) });
      if (!res.ok) return null;
      const m = (await res.json()) as Omit<ApiSample, 't'>;
      return {
        t: new Date().toISOString(),
        wallTimeUs: m.wallTimeUs,
        cpuUserUs: m.cpuUserUs,
        cpuSystemUs: m.cpuSystemUs,
        rssBytes: m.rssBytes,
        pid: m.pid,
      };
    },
    outFile,
  );
}

// --- banco (Supabase) -----------------------------------------------------------------

export interface DbMetricsConfig {
  url: string;
  authHeader: string;
}

/**
 * Lê SUPABASE_PROJECT_REF e SUPABASE_METRICS_KEY do ambiente ou do `.env` da raiz.
 * O ref, se ausente, é extraído do usuário do pooler em apps/api-rls/.env
 * (`app_rls_client.<ref>@...pooler.supabase.com`). Devolve null se não houver chave.
 */
export function loadDbMetricsConfig(): DbMetricsConfig | null {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const key = process.env.SUPABASE_METRICS_KEY;
  if (!key) return null;

  let ref = process.env.SUPABASE_PROJECT_REF;
  if (!ref && existsSync('apps/api-rls/.env')) {
    const match = /DATABASE_URL=postgres(?:ql)?:\/\/[^.:]+\.([a-z0-9]+):/.exec(readFileSync('apps/api-rls/.env', 'utf8'));
    ref = match?.[1];
  }
  if (!ref) throw new Error('SUPABASE_METRICS_KEY definida, mas SUPABASE_PROJECT_REF não (e não deu para deduzir do .env).');

  return {
    url: `https://${ref}.supabase.co/customer/v1/privileged/metrics`,
    authHeader: 'Basic ' + Buffer.from(`service_role:${key}`).toString('base64'),
  };
}

/** Extrai do texto Prometheus só o que o relatório usa. */
export function parsePrometheus(text: string): Omit<DbSample, 't'> {
  let cpuTotalS = 0;
  let cpuIdleS = 0;
  const cpus = new Set<string>();
  let memTotalBytes: number | null = null;
  let memAvailableBytes: number | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line === '') continue;
    const sp = line.lastIndexOf(' ');
    const head = line.slice(0, sp);
    const value = Number(line.slice(sp + 1));
    if (!Number.isFinite(value)) continue;

    if (head.startsWith('node_cpu_seconds_total{')) {
      const mode = /mode="([^"]+)"/.exec(head)?.[1];
      const cpu = /cpu="([^"]+)"/.exec(head)?.[1];
      if (cpu) cpus.add(cpu);
      cpuTotalS += value;
      if (mode === 'idle' || mode === 'iowait') cpuIdleS += value;
    } else if (head.startsWith('node_memory_MemTotal_bytes')) {
      memTotalBytes = value;
    } else if (head.startsWith('node_memory_MemAvailable_bytes')) {
      memAvailableBytes = value;
    }
  }
  return { cpuTotalS, cpuIdleS, cpuCount: cpus.size, memTotalBytes, memAvailableBytes };
}

export async function readDbMetrics(cfg: DbMetricsConfig, timeoutMs = 8000): Promise<Omit<DbSample, 't'>> {
  const res = await fetch(cfg.url, { headers: { Authorization: cfg.authHeader }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${cfg.url}`);
  const parsed = parsePrometheus(await res.text());
  if (parsed.cpuCount === 0) throw new Error('Resposta sem node_cpu_seconds_total.');
  return parsed;
}

export function startDbSampler(cfg: DbMetricsConfig, outFile: string, intervalMs = 5000): Sampler {
  return startLoop<DbSample>(
    intervalMs,
    async () => ({ t: new Date().toISOString(), ...(await readDbMetrics(cfg)) }),
    outFile,
  );
}
