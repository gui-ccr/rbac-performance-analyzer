import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { CreateRecordInput, Pagination } from './types.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
const MAX_TITLE_LENGTH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function parsePositiveInt(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new HttpError(400, `Parâmetro "${name}" deve ser um inteiro >= 1.`);
  }
  return Number(raw);
}

/** Valida `?page=&pageSize=`. Mesma regra nas duas APIs. */
export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = parsePositiveInt(query.page, 'page', 1);
  const pageSize = parsePositiveInt(query.pageSize, 'pageSize', DEFAULT_PAGE_SIZE);
  if (pageSize > MAX_PAGE_SIZE) {
    throw new HttpError(400, `Parâmetro "pageSize" deve ser <= ${MAX_PAGE_SIZE}.`);
  }
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/** Valida o `:id` de GET /records/:id. */
export function parseRecordId(raw: unknown): string {
  if (!isUuid(raw)) throw new HttpError(400, 'O id do registro deve ser um UUID.');
  return raw;
}

/** Valida o body de POST /records. Tenant, owner e departamento vêm do usuário autenticado, nunca do body. */
export function parseCreateRecordBody(body: unknown): CreateRecordInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Body deve ser um objeto JSON.');
  }
  const { title, payload } = body as Record<string, unknown>;

  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE_LENGTH) {
    throw new HttpError(400, `"title" é obrigatório (string de 1 a ${MAX_TITLE_LENGTH} caracteres).`);
  }
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    throw new HttpError(400, '"payload", se informado, deve ser um objeto JSON.');
  }

  return { title: title.trim(), payload: (payload as Record<string, unknown> | undefined) ?? {} };
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // body-parser: JSON malformado / payload grande demais
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON inválido no body.' });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Body grande demais.' });
    return;
  }
  // Postgres: insufficient_privilege / violação de policy de RLS
  if (err?.code === '42501') {
    res.status(403).json({ error: 'Acesso negado.' });
    return;
  }

  console.error('[api] erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno.' });
};
