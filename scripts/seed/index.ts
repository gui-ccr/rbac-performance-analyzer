// Popula o Supabase com o volume de dados de um cenário do experimento.
//
//   npm run seed -- --volume=10000 [--seed=42] [--tenants=10] [--test-users=3] [--dry-run]
//
// ATENÇÃO: SUBSTITUI o conteúdo de tenants, app_users e records (TRUNCATE) —
// inclusive os dados do supabase/seed.sql. Tudo roda numa única transação: se
// algo falhar (ou com --dry-run), nada é alterado.
//
// Conexão: precisa de um role com permissão de TRUNCATE/INSERT (o dono das
// tabelas, ex. `postgres`) — NÃO o app_rls_client, que só lê. Usa
// SEED_DATABASE_URL, ou o DATABASE_URL de apps/api-middleware/.env.
// Saída: scripts/seed/output/test-users.json, com usuários de teste + JWTs para o k6.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { signToken } from '@rbac/shared';
import {
  ADMINS_PER_TENANT,
  DEPARTMENTS,
  MANAGERS_PER_DEPARTMENT,
  VIEWERS_PER_TENANT,
  expectedVisibleCounts,
  generateSeedData,
  type Role,
  type SeedData,
  type SeedUser,
} from './generate.js';

const BATCH_SIZE = 5000;
const OUTPUT_FILE = 'scripts/seed/output/test-users.json';
const TOKEN_TTL = '90d';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function intArg(name: string, fallback?: number): number {
  const raw = arg(name, fallback === undefined ? undefined : String(fallback));
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value <= 0) {
    console.error(`Parâmetro --${name} é obrigatório e deve ser um inteiro > 0 (recebido: ${raw ?? 'nada'}).`);
    process.exit(1);
  }
  return value;
}

const volume = intArg('volume');
const seed = intArg('seed', 42);
const tenantCount = intArg('tenants', 10);
const testUsersPerRole = Math.min(intArg('test-users', 3), tenantCount);
const dryRun = process.argv.includes('--dry-run');

// --- ambiente -------------------------------------------------------------
if (!process.env.SEED_DATABASE_URL && !process.env.DATABASE_URL && existsSync('apps/api-middleware/.env')) {
  process.loadEnvFile('apps/api-middleware/.env');
}
if (!process.env.JWT_SECRET && existsSync('apps/api-rls/.env')) process.loadEnvFile('apps/api-rls/.env');

const databaseUrl = process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
if (!databaseUrl) {
  console.error('Defina SEED_DATABASE_URL (ou DATABASE_URL em apps/api-middleware/.env), com um role dono das tabelas.');
  process.exit(1);
}
if (!jwtSecret) {
  console.error('JWT_SECRET não definido (ver apps/api-rls/.env).');
  process.exit(1);
}

// --- geração ---------------------------------------------------------------
console.time('geração em memória');
const data = generateSeedData({ volume, seed, tenants: tenantCount });
const expected = expectedVisibleCounts(data);
console.timeEnd('geração em memória');

console.log(
  `\nDataset: ${data.tenants.length} tenants, ${data.users.length} usuários ` +
    `(${ADMINS_PER_TENANT} admin + ${DEPARTMENTS * MANAGERS_PER_DEPARTMENT} manager + ${VIEWERS_PER_TENANT} viewer por tenant), ` +
    `${data.records.length} records | seed=${seed}${dryRun ? ' | DRY-RUN (rollback no final)' : ''}`,
);

// --- gravação --------------------------------------------------------------
function chunk<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) out.push(items.slice(i, i + BATCH_SIZE));
  return out;
}

function pickTestUsers(d: SeedData): SeedUser[] {
  const roles: Role[] = ['admin', 'manager', 'viewer'];
  const picked: SeedUser[] = [];
  for (const role of roles) {
    for (let j = 0; j < testUsersPerRole; j++) {
      const tenant = d.tenants[j];
      const user = d.users.find((u) => u.role === role && u.tenantId === tenant?.id);
      if (user) picked.push(user);
    }
  }
  return picked;
}

async function countVisible(client: pg.Client, user: SeedUser): Promise<number> {
  // Mesma regra de RBAC, em SQL direto (sem RLS/middleware): tenant [+ departamento | + owner].
  const sql =
    user.role === 'admin'
      ? ['select count(*)::int as n from records where tenant_id = $1', [user.tenantId]]
      : user.role === 'manager'
        ? ['select count(*)::int as n from records where tenant_id = $1 and department_id = $2', [user.tenantId, user.departmentId]]
        : ['select count(*)::int as n from records where tenant_id = $1 and owner_id = $2', [user.tenantId, user.id]];
  const { rows } = await client.query<{ n: number }>(sql[0] as string, sql[1] as unknown[]);
  return rows[0]?.n ?? 0;
}

const testUsers = pickTestUsers(data);
const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const priv = await client.query<{ ok: boolean; role: string }>(
    `select current_user as role,
            has_table_privilege(current_user, 'records', 'TRUNCATE') and has_table_privilege(current_user, 'records', 'INSERT') as ok`,
  );
  if (!priv.rows[0]?.ok) {
    throw new Error(
      `O role "${priv.rows[0]?.role}" não tem TRUNCATE/INSERT em records. Use um role dono das tabelas (SEED_DATABASE_URL).`,
    );
  }

  const before = await client.query<{ t: number; u: number; r: number }>(
    'select (select count(*) from tenants)::int t, (select count(*) from app_users)::int u, (select count(*) from records)::int r',
  );
  console.log(`Antes:  tenants=${before.rows[0]?.t} app_users=${before.rows[0]?.u} records=${before.rows[0]?.r} (serão substituídos)`);

  console.time('gravação no banco');
  await client.query('begin');
  await client.query('truncate records, app_users, tenants');

  await client.query('insert into tenants (id, name) select * from unnest($1::uuid[], $2::text[])', [
    data.tenants.map((t) => t.id),
    data.tenants.map((t) => t.name),
  ]);

  for (const batch of chunk(data.users)) {
    await client.query(
      `insert into app_users (id, tenant_id, department_id, role, email)
       select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[])`,
      [
        batch.map((u) => u.id),
        batch.map((u) => u.tenantId),
        batch.map((u) => u.departmentId),
        batch.map((u) => u.role),
        batch.map((u) => u.email),
      ],
    );
  }

  let inserted = 0;
  for (const batch of chunk(data.records)) {
    await client.query(
      `insert into records (id, tenant_id, owner_id, department_id, title, payload, created_at)
       select a, b, c, d, e, f::jsonb, g
       from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::timestamptz[]) as t(a, b, c, d, e, f, g)`,
      [
        batch.map((r) => r.id),
        batch.map((r) => r.tenantId),
        batch.map((r) => r.ownerId),
        batch.map((r) => r.departmentId),
        batch.map((r) => r.title),
        batch.map((r) => r.payload),
        batch.map((r) => r.createdAt),
      ],
    );
    inserted += batch.length;
    process.stdout.write(`\r  records: ${inserted}/${data.records.length}`);
  }
  process.stdout.write('\n');

  // Verificação ainda dentro da transação: contagens totais e visibilidade por papel.
  const totals = await client.query<{ t: number; u: number; r: number }>(
    'select (select count(*) from tenants)::int t, (select count(*) from app_users)::int u, (select count(*) from records)::int r',
  );
  const got = totals.rows[0];
  if (got?.t !== data.tenants.length || got.u !== data.users.length || got.r !== data.records.length) {
    throw new Error(`Contagens divergentes após a gravação: ${JSON.stringify(got)}`);
  }
  for (const user of testUsers) {
    const actual = await countVisible(client, user);
    if (actual !== expected.get(user.id)) {
      throw new Error(`Visibilidade divergente para ${user.role} ${user.email}: banco=${actual}, esperado=${expected.get(user.id)}`);
    }
  }
  console.log(`Verificação OK: contagens totais e visibilidade de ${testUsers.length} usuários de teste batem com o esperado.`);

  if (dryRun) {
    await client.query('rollback');
    console.timeEnd('gravação no banco');
    console.log('\nDRY-RUN: transação descartada, banco inalterado.');
    process.exit(0);
  }
  await client.query('commit');
  console.timeEnd('gravação no banco');

  // Estatísticas atualizadas: sem isso o planner decide com estimativas velhas e o resultado do teste de carga fica ruído.
  console.time('analyze');
  await client.query('analyze tenants');
  await client.query('analyze app_users');
  await client.query('analyze records');
  console.timeEnd('analyze');
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error('\nFalha — transação revertida, banco inalterado.');
  throw err;
} finally {
  await client.end();
}

// --- usuários de teste para o k6 -------------------------------------------
mkdirSync('scripts/seed/output', { recursive: true });
writeFileSync(
  OUTPUT_FILE,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      volume,
      seed,
      tenants: tenantCount,
      users: testUsers.map((u) => ({
        role: u.role,
        id: u.id,
        tenantId: u.tenantId,
        departmentId: u.departmentId,
        email: u.email,
        expectedRecords: expected.get(u.id),
        token: signToken(u.id, jwtSecret, TOKEN_TTL),
      })),
    },
    null,
    2,
  ),
);

console.log(`\nConcluído. Usuários de teste + JWTs: ${OUTPUT_FILE}`);
console.log('Registros visíveis por usuário de teste:');
for (const u of testUsers) console.log(`  ${u.role.padEnd(7)} ${u.email.padEnd(24)} ${expected.get(u.id)}`);
console.log(`\nLembrete: atualize DATA_VOLUME=${volume} nos .env das APIs (usado para nomear os runs).`);
