// Gera um JWT de teste para um usuário de `app_users`, para chamar as APIs manualmente:
//   npm run token -- <user-id>
// Usa o JWT_SECRET de apps/api-rls/.env (o mesmo valor deve estar nas duas APIs).
// O gerador de seed (scripts/seed/, a implementar) emitirá os tokens do experimento.
import { existsSync } from 'node:fs';
import { signToken } from '@rbac/shared';

const userId = process.argv[2];
if (!userId) {
  console.error('Uso: npm run token -- <user-id>');
  process.exit(1);
}

const envFile = 'apps/api-rls/.env';
if (!process.env.JWT_SECRET && existsSync(envFile)) process.loadEnvFile(envFile);

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error(`JWT_SECRET não definido (defina no ambiente ou em ${envFile}).`);
  process.exit(1);
}

console.log(signToken(userId, secret));
