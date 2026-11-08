import pg from 'pg';
import { isUuid } from '@rbac/shared';

/** Literal de texto seguro para inlining (o simple query protocol não aceita `$1`). */
export const lit = (value: string): string => pg.escapeLiteral(value);

/** Inteiro para inlining; recusa qualquer coisa que não seja inteiro seguro. */
export const int = (value: number): string => {
  if (!Number.isSafeInteger(value)) throw new Error(`Inteiro inválido: ${value}`);
  return String(value);
};

/**
 * Executa `sql` com `app.current_user_id = userId` em UMA ida ao banco:
 *
 *   select set_config('app.current_user_id', '<uuid>', true); <sql>
 *
 * As duas instruções vão numa única mensagem do *simple query protocol*, que o
 * Postgres executa como UMA transação implícita. Por isso o `true` do
 * set_config (local à transação, como SET LOCAL) vale para `sql` e não vaza
 * para outra requisição que reaproveite a conexão — a mesma garantia do
 * antigo BEGIN → set_config → query → COMMIT, que custava 4 idas ao banco.
 * Decisão registrada em docs/DECISOES_DE_PROJETO.md (cada abordagem no seu
 * mínimo de idas ao banco).
 *
 * O simple protocol não aceita parâmetros: todo valor em `sql` precisa entrar
 * via `lit()`/`int()`. Literais e parâmetros de statement anônimo recebem o
 * mesmo tipo de plano (custom, a cada execução), então o plano é equivalente
 * ao que a api-middleware obtém com `$1`.
 *
 * A API informa só a identidade verificada; o papel é resolvido pelas
 * policies a partir de `app_users` (ver docs/POLITICAS_RLS.md).
 */
export async function queryAsUser<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  userId: string,
  sql: string,
): Promise<pg.QueryResult<T>> {
  if (!isUuid(userId)) throw new Error('userId inválido.');
  const results = (await pool.query(
    `select set_config('app.current_user_id', ${lit(userId)}, true); ${sql}`,
  )) as unknown as pg.QueryResult<T>[];
  const last = Array.isArray(results) ? results[1] : undefined;
  if (!last) throw new Error('queryAsUser: esperados 2 resultados (set_config + sql).');
  return last;
}

/**
 * Falha na inicialização se o RLS não for realmente aplicado a esta conexão.
 *
 * RLS é ignorado SILENCIOSAMENTE por superusers, roles com BYPASSRLS e pelo
 * dono da tabela — nesses casos o teste mediria "sem RLS" achando que é
 * "com RLS". Melhor recusar a subir do que gerar dados inválidos.
 */
export async function assertRlsEnforced(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{
    role: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    relrowsecurity: boolean | null;
    is_owner: boolean | null;
  }>(`
    select
      current_user as role,
      r.rolsuper,
      r.rolbypassrls,
      c.relrowsecurity,
      (c.relowner = r.oid) as is_owner
    from pg_roles r
    left join pg_class c on c.oid = to_regclass('public.records')
    where r.rolname = current_user
  `);

  const info = rows[0];
  if (!info) throw new Error('Não foi possível inspecionar o role de conexão.');

  const problems: string[] = [];
  if (info.rolsuper) problems.push('o role é superuser');
  if (info.rolbypassrls) problems.push('o role tem BYPASSRLS');
  if (info.is_owner) problems.push('o role é dono da tabela records');
  if (info.relrowsecurity === null) problems.push('a tabela public.records não existe');
  else if (!info.relrowsecurity) problems.push('RLS não está habilitado em public.records');

  if (problems.length > 0) {
    throw new Error(
      `Conexão inválida para o cenário RLS (role "${info.role}"): ${problems.join('; ')}. ` +
        'Use o role app_rls_client (ver supabase/migrations e docs/POLITICAS_RLS.md).',
    );
  }
}
