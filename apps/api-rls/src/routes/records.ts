import { Router } from 'express';
import type pg from 'pg';
import {
  HttpError,
  parseCreateRecordBody,
  parsePagination,
  parseRecordId,
  type ListRecordsResponse,
  type RecordRow,
} from '@rbac/shared';
import { int, lit, queryAsUser } from '../db.js';

/**
 * Rotas de records da api-rls. NENHUMA query de leitura aqui tem `WHERE` de
 * autorização: quem filtra as linhas por papel/tenant/departamento são as
 * policies de RLS (supabase/migrations/20260920120200_enable_rls_records.sql).
 * Precisa rodar depois de `createAuthenticate` (usa `req.userId`).
 */
export function recordsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const userId = req.userId!;
    const { page, pageSize, limit, offset } = parsePagination(req.query);

    const { rows } = await queryAsUser<RecordRow>(
      pool,
      userId,
      `select * from records order by created_at desc, id desc limit ${int(limit)} offset ${int(offset)}`,
    );

    const body: ListRecordsResponse = { data: rows, page, pageSize };
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    const userId = req.userId!;
    const id = parseRecordId(req.params.id);

    const { rows } = await queryAsUser<RecordRow>(pool, userId, `select * from records where id = ${lit(id)}`);

    // Registro inexistente e registro invisível pela policy são indistinguíveis (404 nos dois casos).
    if (rows.length === 0) throw new HttpError(404, 'Registro não encontrado.');
    res.json(rows[0]);
  });

  router.post('/', async (req, res) => {
    const userId = req.userId!;
    const { title, payload } = parseCreateRecordBody(req.body);

    // tenant/departamento vêm de `app_users` (não do body); `records_insert_own`
    // valida no banco que owner_id e tenant_id batem com o usuário da sessão.
    const { rows } = await queryAsUser<RecordRow>(
      pool,
      userId,
      `insert into records (tenant_id, owner_id, department_id, title, payload)
       select tenant_id, id, department_id, ${lit(title)}, ${lit(JSON.stringify(payload))}::jsonb
       from app_users
       where id = ${lit(userId)}
       returning *`,
    );

    if (rows.length === 0) throw new HttpError(401, 'Usuário não encontrado.');
    res.status(201).json(rows[0]);
  });

  return router;
}
