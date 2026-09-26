import express from 'express';
import type pg from 'pg';
import { createAuthenticate, errorHandler, notFoundHandler, type AppConfig } from '@rbac/shared';
import { recordsRouter } from './routes/records.js';

export function createApp(config: AppConfig, pool: pg.Pool): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', strategy: 'rls' });
  });

  // Autenticação (JWT -> user_id) e, a partir daí, o banco decide o que cada usuário vê.
  app.use('/records', createAuthenticate(config.jwtSecret), recordsRouter(pool));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
