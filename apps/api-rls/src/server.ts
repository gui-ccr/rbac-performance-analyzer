import { createPool, loadConfig } from '@rbac/shared';
import { createApp } from './app.js';
import { assertRlsEnforced } from './db.js';

const config = loadConfig(3001);
const pool = createPool(config);

await assertRlsEnforced(pool);

const server = createApp(config, pool).listen(config.port, () => {
  console.log(`[api-rls] escutando na porta ${config.port} (RLS verificado no role de conexão)`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api-rls] ${signal} recebido, encerrando...`);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
