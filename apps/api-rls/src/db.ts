import type pg from 'pg';

/**
 * Executa `fn` numa transação em que `app.current_user_id` vale `userId`.
 *
 *   BEGIN → set_config('app.current_user_id', userId, true) → fn(client) → COMMIT
 *
 * O `true` do set_config o torna local à transação (como SET LOCAL): não
 * vaza para outra requisição que reaproveite a mesma conexão do pool, e só
 * tem efeito se `set_config` e a query de negócio rodarem na MESMA
 * transação/conexão — por isso `fn` recebe o client, nunca o pool.
 *
 * A API informa só a identidade verificada; o papel é resolvido pelas
 * policies a partir de `app_users` (ver docs/POLITICAS_RLS.md).
 */
export async function withUserContext<T>(
  pool: pg.Pool,
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true; // conexão em estado desconhecido: não devolver ao pool
    }
    throw err;
  } finally {
    client.release(discard);
  }
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
