// Geração pura (sem banco) do dataset do experimento.
//
// Estrutura CONSTANTE entre volumes (tenants, departamentos, usuários): só a
// quantidade de `records` muda entre 10k/50k/100k, para que o volume seja a
// única variável independente. Os departamentos são um pool global reaproveitado
// por TODOS os tenants — de propósito, para que a regra "tenant + departamento"
// (decisão 7) seja de fato exercitada: sem o filtro de tenant, um manager
// enxergaria os records do mesmo departamento em outros tenants.
import { createRng, type Rng } from './prng.js';

export type Role = 'admin' | 'manager' | 'viewer';

export interface SeedParams {
  /** Quantidade de linhas em `records`. */
  volume: number;
  seed: number;
  tenants: number;
}

export const DEPARTMENTS = 5;
export const ADMINS_PER_TENANT = 2;
export const MANAGERS_PER_DEPARTMENT = 2;
export const VIEWERS_PER_TENANT = 50;

/** Data fixa (não `now()`), para o dataset ser idêntico em qualquer execução. */
const CREATED_AT_BASE = Date.UTC(2026, 5, 1);
const CREATED_AT_SPREAD_SECONDS = 180 * 24 * 3600;

export interface SeedTenant {
  id: string;
  name: string;
}
export interface SeedUser {
  id: string;
  tenantId: string;
  departmentId: string;
  role: Role;
  email: string;
}
export interface SeedRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  departmentId: string;
  title: string;
  /** JSON já serializado. */
  payload: string;
  createdAt: string;
}
export interface SeedData {
  params: SeedParams;
  departments: string[];
  tenants: SeedTenant[];
  users: SeedUser[];
  records: SeedRecord[];
}

const STATUSES = ['open', 'in_progress', 'waiting', 'closed'] as const;
const CHANNELS = ['phone', 'email', 'chat', 'in_person'] as const;

function buildStructure(rng: Rng, tenantCount: number) {
  const departments = Array.from({ length: DEPARTMENTS }, () => rng.uuid());
  const tenants: SeedTenant[] = [];
  const users: SeedUser[] = [];

  for (let t = 0; t < tenantCount; t++) {
    const tenantId = rng.uuid();
    tenants.push({ id: tenantId, name: `Tenant ${t + 1}` });

    const add = (role: Role, n: number, departmentId: string) => {
      users.push({
        id: rng.uuid(),
        tenantId,
        departmentId,
        role,
        email: `${role}${n}.t${t + 1}@seed.test`,
      });
    };

    for (let i = 0; i < ADMINS_PER_TENANT; i++) add('admin', i + 1, departments[i % DEPARTMENTS] as string);

    // Todo manager tem department_id (manager sem departamento não veria nada — ver POLITICAS_RLS.md).
    let m = 0;
    for (const dept of departments) {
      for (let i = 0; i < MANAGERS_PER_DEPARTMENT; i++) add('manager', ++m, dept);
    }

    for (let i = 0; i < VIEWERS_PER_TENANT; i++) add('viewer', i + 1, rng.pick(departments));
  }

  return { departments, tenants, users };
}

export function generateSeedData(params: SeedParams): SeedData {
  // Duas streams independentes: tenants/usuários NÃO dependem do volume, então
  // os mesmos ids de usuário (e tokens) valem em 10k, 50k e 100k.
  const { departments, tenants, users } = buildStructure(createRng(params.seed), params.tenants);
  const rng = createRng(params.seed ^ 0x9e3779b9);

  const usersByTenant = new Map<string, SeedUser[]>();
  for (const u of users) {
    const list = usersByTenant.get(u.tenantId) ?? [];
    list.push(u);
    usersByTenant.set(u.tenantId, list);
  }

  const records: SeedRecord[] = new Array(params.volume);
  for (let i = 0; i < params.volume; i++) {
    // Round-robin: records distribuídos por igual entre os tenants (e o dataset de 10k é prefixo do de 100k).
    const tenant = tenants[i % tenants.length] as SeedTenant;
    const owner = rng.pick(usersByTenant.get(tenant.id) as SeedUser[]);

    records[i] = {
      id: rng.uuid(),
      tenantId: tenant.id,
      ownerId: owner.id,
      departmentId: owner.departmentId, // igual ao que POST /records faz nas duas APIs
      title: `Atendimento #${i + 1}`,
      payload: JSON.stringify({
        status: rng.pick(STATUSES),
        priority: 1 + rng.int(5),
        channel: rng.pick(CHANNELS),
        notes: `Registro sintético ${i + 1} do ${tenant.name}.`,
      }),
      createdAt: new Date(CREATED_AT_BASE - rng.int(CREATED_AT_SPREAD_SECONDS) * 1000).toISOString(),
    };
  }

  return { params, departments, tenants, users, records };
}

/**
 * Quantos records cada usuário deve enxergar segundo a regra de RBAC
 * (admin: tenant; manager: tenant + departamento; viewer: tenant + owner).
 * Calculado em memória, independente de SQL/RLS/middleware — usado para
 * validar o que foi gravado e para documentar o tamanho do resultado de cada
 * usuário de teste.
 */
export function expectedVisibleCounts(data: SeedData): Map<string, number> {
  const byTenant = new Map<string, number>();
  const byTenantDept = new Map<string, number>();
  const byTenantOwner = new Map<string, number>();
  for (const r of data.records) {
    byTenant.set(r.tenantId, (byTenant.get(r.tenantId) ?? 0) + 1);
    const td = `${r.tenantId}|${r.departmentId}`;
    byTenantDept.set(td, (byTenantDept.get(td) ?? 0) + 1);
    const to = `${r.tenantId}|${r.ownerId}`;
    byTenantOwner.set(to, (byTenantOwner.get(to) ?? 0) + 1);
  }

  const result = new Map<string, number>();
  for (const u of data.users) {
    const count =
      u.role === 'admin'
        ? byTenant.get(u.tenantId)
        : u.role === 'manager'
          ? byTenantDept.get(`${u.tenantId}|${u.departmentId}`)
          : byTenantOwner.get(`${u.tenantId}|${u.id}`);
    result.set(u.id, count ?? 0);
  }
  return result;
}
