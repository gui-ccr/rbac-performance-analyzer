import type { RequestHandler } from 'express';
import type pg from 'pg';
import { HttpError, type AppUser } from '@rbac/shared';
import { getUserById } from '../db.js';

/**
 * Restrições de visibilidade sobre `records`, decididas pela aplicação.
 * Uma chave presente vira uma condição `coluna = $n` combinada com AND.
 */
export interface RecordsFilter {
  tenantId: string;
  /** Presente para `manager`. `null` (manager sem departamento) não casa com nada — falha fechada, igual ao RLS. */
  departmentId?: string | null;
  ownerId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AppUser;
      recordsFilter?: RecordsFilter;
    }
  }
}

/**
 * Regra de RBAC (docs/ARQUITETURA.md) — equivalente à das policies de RLS:
 *   admin   -> todos os records do próprio tenant
 *   manager -> records do próprio tenant e do próprio departamento
 *   viewer  -> records do próprio tenant dos quais é owner
 */
export function buildRecordsFilter(user: AppUser): RecordsFilter {
  switch (user.role) {
    case 'admin':
      return { tenantId: user.tenantId };
    case 'manager':
      return { tenantId: user.tenantId, departmentId: user.departmentId };
    case 'viewer':
      return { tenantId: user.tenantId, ownerId: user.id };
  }
}

/**
 * Middleware de autorização: roda depois de `createAuthenticate`, resolve o
 * usuário em `app_users` e deixa em `req.recordsFilter` o filtro que os
 * handlers aplicam ao montar o SQL.
 */
export function authorizeRecordsAccess(pool: pg.Pool): RequestHandler {
  return async (req, _res, next) => {
    const user = await getUserById(pool, req.userId!);
    if (!user) throw new HttpError(401, 'Usuário não encontrado.');

    req.user = user;
    req.recordsFilter = buildRecordsFilter(user);
    next();
  };
}
