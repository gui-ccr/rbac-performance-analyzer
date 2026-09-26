// Checa se api-rls e api-middleware devolvem EXATAMENTE os mesmos registros
// (mesmos ids, na mesma ordem) para os mesmos usuários. Rodar antes de cada
// coleta de dados: se falhar, a regra de RBAC diverge entre as duas
// abordagens e os números de latência/CPU não são comparáveis
// (docs/METODOLOGIA.md, ameaça "diferença de implementação não intencional").
//
//   npm run check:equivalence -- [--rls-url=http://localhost:3001] [--mw-url=http://localhost:3002]
//                                [--max-pages=20] [--max-users=30]
//
// Pré-requisitos: as duas APIs no ar, com o MESMO JWT_SECRET. Lê DATABASE_URL e
// JWT_SECRET de apps/api-rls/.env (ou do ambiente) só para listar usuários de
// `app_users` e assinar os tokens de teste.
import { existsSync } from 'node:fs';
import { createPool, loadConfig, signToken, type Role } from '@rbac/shared';

const PAGE_SIZE = 100;

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const rlsUrl = arg('rls-url', 'http://localhost:3001');
const mwUrl = arg('mw-url', 'http://localhost:3002');
const maxPages = Number(arg('max-pages', '20'));
const maxUsers = Number(arg('max-users', '30'));

const envFile = 'apps/api-rls/.env';
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig(0);

interface UserRow {
  id: string;
  role: Role;
  tenant_id: string;
}

/** Um usuário por (tenant, papel) — cobre todos os papéis em todos os tenants, sem varrer a tabela toda. */
async function pickUsers(): Promise<UserRow[]> {
  const pool = createPool(config);
  try {
    const { rows } = await pool.query<UserRow>(
      `select distinct on (tenant_id, role) id, role, tenant_id
       from app_users
       order by tenant_id, role, id
       limit $1`,
      [maxUsers],
    );
    return rows;
  } finally {
    await pool.end();
  }
}

async function fetchIds(baseUrl: string, token: string): Promise<{ ids: string[]; exhaustive: boolean }> {
  const ids: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${baseUrl}/records?page=${page}&pageSize=${PAGE_SIZE}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${baseUrl} respondeu HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: { id: string }[] };
    ids.push(...body.data.map((r) => r.id));
    if (body.data.length < PAGE_SIZE) return { ids, exhaustive: true };
  }
  return { ids, exhaustive: false };
}

const users = await pickUsers();
if (users.length === 0) {
  console.error('Nenhum usuário em app_users — rode o seed antes.');
  process.exit(1);
}

console.log(`Comparando ${rlsUrl} (rls) x ${mwUrl} (middleware) para ${users.length} usuário(s)...\n`);

let failures = 0;
for (const user of users) {
  const token = signToken(user.id, config.jwtSecret, '10m');
  const [rls, mw] = await Promise.all([fetchIds(rlsUrl, token), fetchIds(mwUrl, token)]);

  const same = rls.ids.length === mw.ids.length && rls.ids.every((id, i) => id === mw.ids[i]);
  if (!same) failures++;

  const scope = rls.exhaustive && mw.exhaustive ? 'completo' : `primeiras ${maxPages * PAGE_SIZE} linhas`;
  const label = `${user.role.padEnd(7)} tenant ${user.tenant_id.slice(0, 8)} user ${user.id.slice(0, 8)}`;
  console.log(
    `${same ? 'OK   ' : 'FALHA'} ${label} | rls=${rls.ids.length} middleware=${mw.ids.length} (${scope})`,
  );
}

console.log(failures === 0 ? '\nEquivalentes.' : `\n${failures} usuário(s) com resultados divergentes.`);
process.exit(failures === 0 ? 0 : 1);
