import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError, isUuid } from './http.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Identidade verificada (claim `sub` do JWT). Preenchido por `createAuthenticate`. */
      userId?: string;
    }
  }
}

/**
 * Autenticação idêntica nas duas APIs (ver docs/ARQUITETURA.md, "Autenticação
 * usada nos testes"): valida a assinatura do JWT (HS256, sem chamada de rede)
 * e extrai só o `user_id`. Papel/tenant/departamento NÃO vêm do token — cada
 * abordagem os resolve a partir de `app_users`.
 */
export function createAuthenticate(secret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new HttpError(401, 'Token ausente. Use "Authorization: Bearer <jwt>".');
    }

    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(header.slice('Bearer '.length), secret, { algorithms: ['HS256'] });
    } catch {
      throw new HttpError(401, 'Token inválido ou expirado.');
    }

    const sub = typeof payload === 'string' ? undefined : payload.sub;
    if (!isUuid(sub)) throw new HttpError(401, 'Token sem `sub` (user id) válido.');

    req.userId = sub;
    next();
  };
}

/** Emite um JWT de teste para um usuário de `app_users`. */
export function signToken(userId: string, secret: string, expiresIn: jwt.SignOptions['expiresIn'] = '30d'): string {
  return jwt.sign({}, secret, { subject: userId, algorithm: 'HS256', expiresIn });
}
