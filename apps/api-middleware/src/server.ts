import { createPool, loadConfig } from '@rbac/shared';
import { createApp } from './app.js';

const config = loadConfig(3002);
const pool = createPool(config);

const server = createApp(config, pool).listen(config.port, () => {
  console.log(`[api-middleware] escutando na porta ${config.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api-middleware] ${signal} recebido, encerrando...`);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
