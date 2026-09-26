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
import type { RecordsFilter } from '../middleware/authorizeRecordsAccess.js';

/** Traduz `req.recordsFilter` em `where ... and ...` com placeholders a partir de `$firstParam`. */
function buildWhere(filter: RecordsFilter, firstParam: number): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    conditions.push(`${column} = $${firstParam + params.length - 1}`);
  };

  add('tenant_id', filter.tenantId);
  if (filter.departmentId !== undefined) add('department_id', filter.departmentId);
  if (filter.ownerId !== undefined) add('owner_id', filter.ownerId);

  return { conditions, params };
}

/**
 * Rotas de records da api-middleware. O filtro de RBAC é aplicado aqui, no
 * SQL montado pela aplicação, a partir do `req.recordsFilter` que o
 * middleware `authorizeRecordsAccess` deixou na requisição. O banco não tem
 * RLS neste cenário: recebe a query já restrita.
 */
export function recordsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { page, pageSize, limit, offset } = parsePagination(req.query);
    const { conditions, params } = buildWhere(req.recordsFilter!, 1);

    const { rows } = await pool.query<RecordRow>(
      `select * from records
       where ${conditions.join(' and ')}
       order by created_at desc, id desc
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset],
    );

    const body: ListRecordsResponse = { data: rows, page, pageSize };
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    const id = parseRecordId(req.params.id);
    const { conditions, params } = buildWhere(req.recordsFilter!, 2);

    const { rows } = await pool.query<RecordRow>(
      `select * from records where id = $1 and ${conditions.join(' and ')}`,
      [id, ...params],
    );

    // Registro inexistente e registro fora do filtro do usuário são indistinguíveis (404 nos dois casos).
    if (rows.length === 0) throw new HttpError(404, 'Registro não encontrado.');
    res.json(rows[0]);
  });

  router.post('/', async (req, res) => {
    const user = req.user!;
    const { title, payload } = parseCreateRecordBody(req.body);

    // Tenant, owner e departamento vêm do usuário autenticado, nunca do body.
    const { rows } = await pool.query<RecordRow>(
      `insert into records (tenant_id, owner_id, department_id, title, payload)
       values ($1, $2, $3, $4, $5::jsonb)
       returning *`,
      [user.tenantId, user.id, user.departmentId, title, JSON.stringify(payload)],
    );

    res.status(201).json(rows[0]);
  });

  return router;
}
