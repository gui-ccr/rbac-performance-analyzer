import express from 'express';
import type pg from 'pg';
import { createAuthenticate, errorHandler, notFoundHandler, type AppConfig } from '@rbac/shared';
import { authorizeRecordsAccess } from './middleware/authorizeRecordsAccess.js';
import { recordsRouter } from './routes/records.js';

export function createApp(config: AppConfig, pool: pg.Pool): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', strategy: 'middleware' });
  });

  // Autenticação (JWT -> user_id) e, em seguida, a autorização na camada de aplicação.
  app.use('/records', createAuthenticate(config.jwtSecret), authorizeRecordsAccess(pool), recordsRouter(pool));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
