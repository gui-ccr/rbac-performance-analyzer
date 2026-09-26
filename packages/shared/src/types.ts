// Contrato comum às duas APIs. Manter aqui garante que api-rls e
// api-middleware não divirjam de request/response sem querer
// (ver docs/DECISOES_DE_PROJETO.md, decisão 2).

export type Role = 'admin' | 'manager' | 'viewer';

/** Linha da tabela `records`, como devolvida pelas duas APIs. */
export interface RecordRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  department_id: string | null;
  title: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/** Usuário resolvido a partir de `app_users` (usado pelo middleware). */
export interface AppUser {
  id: string;
  tenantId: string;
  departmentId: string | null;
  role: Role;
}

/** Body aceito por POST /records. */
export interface CreateRecordInput {
  title: string;
  payload: Record<string, unknown>;
}

/** Resposta de GET /records. */
export interface ListRecordsResponse {
  data: RecordRow[];
  page: number;
  pageSize: number;
}

export interface Pagination {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}
