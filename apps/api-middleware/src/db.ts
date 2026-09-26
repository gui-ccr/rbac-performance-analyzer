import type pg from 'pg';
import type { AppUser, Role } from '@rbac/shared';

interface AppUserRow {
  id: string;
  tenant_id: string;
  department_id: string | null;
  role: Role;
}

/**
 * Resolve papel/tenant/departamento do usuário em `app_users` — a mesma fonte
 * de verdade que as policies de RLS consultam no cenário api-rls. Sem cache
 * de propósito: o RLS também consulta `app_users` a cada requisição, então
 * cachear aqui favoreceria o middleware por uma razão alheia à hipótese.
 */
export async function getUserById(pool: pg.Pool, userId: string): Promise<AppUser | null> {
  const { rows } = await pool.query<AppUserRow>(
    'select id, tenant_id, department_id, role from app_users where id = $1',
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, tenantId: row.tenant_id, departmentId: row.department_id, role: row.role };
}
