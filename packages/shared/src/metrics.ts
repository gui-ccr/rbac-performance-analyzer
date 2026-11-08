import os from 'node:os';
import type { RequestHandler } from 'express';

/**
 * GET /metrics — contadores CUMULATIVOS de CPU e memória do processo da API.
 *
 * Idêntico nas duas APIs. Quem calcula o % de CPU é o coletor
 * (scripts/run/samplers.ts), pela diferença entre duas leituras:
 *
 *   cpu% = Δ(user + system) / Δ(tempo de parede) × 100
 *
 * (100% = um núcleo inteiro; pode passar de 100% pelas threads do libuv/GC.)
 * Contadores cumulativos, e não um % já pronto, para que a janela de cálculo
 * seja a do coletor (a execução do k6) e nada se perca entre leituras.
 * O custo de responder é desprezível e igual nas duas APIs.
 */
export function metricsHandler(strategy: 'rls' | 'middleware'): RequestHandler {
  return (_req, res) => {
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    res.set('Cache-Control', 'no-store').json({
      strategy,
      pid: process.pid,
      wallTimeUs: Number(process.hrtime.bigint() / 1000n),
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      cpuCount: os.availableParallelism(),
      loadAvg1m: os.loadavg()[0] ?? 0, // sempre 0 no Windows
    });
  };
}
