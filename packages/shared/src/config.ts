import { existsSync } from 'node:fs';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  /** Tamanho máximo do pool — igual nas duas APIs (variável controlada). */
  dbPoolMax: number;
  dbSsl: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida (ver .env.example).`);
  }
  return value;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Variável de ambiente ${name} inválida: "${raw}".`);
  }
  return parsed;
}

/**
 * Lê a configuração do ambiente. Carrega `.env` do diretório atual (o
 * workspace da API, quando rodado via `npm run ... --workspace`) sem
 * sobrescrever variáveis já definidas no processo.
 */
export function loadConfig(defaultPort: number): AppConfig {
  if (existsSync('.env')) process.loadEnvFile('.env');

  return {
    port: intFromEnv('PORT', defaultPort),
    databaseUrl: requireEnv('DATABASE_URL'),
    jwtSecret: requireEnv('JWT_SECRET'),
    dbPoolMax: intFromEnv('DB_POOL_MAX', 10),
    dbSsl: process.env.DATABASE_SSL !== 'false',
  };
}
