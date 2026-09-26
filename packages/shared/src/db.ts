import pg from 'pg';
import type { AppConfig } from './config.js';

/**
 * Cria o pool de conexões. Vive no shared para que as duas APIs usem
 * exatamente as mesmas configurações de pool/SSL/timeouts — só o role de
 * conexão (DATABASE_URL) e o uso das conexões diferem entre elas.
 */
export function createPool(config: AppConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // O pooler do Supabase usa certificado próprio; sem CA local, não valida a cadeia.
    ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
  });

  // Erro em conexão ociosa não pode derrubar o processo.
  pool.on('error', (err) => {
    console.error('[pg] erro em conexão ociosa do pool:', err.message);
  });

  return pool;
}
