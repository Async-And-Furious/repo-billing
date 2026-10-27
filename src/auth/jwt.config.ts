import { ConfigService } from '@nestjs/config';

export type JwtAlgorithm = 'HS256' | 'RS256';

export interface JwtContract {
  algorithm: JwtAlgorithm;
  issuer: string;
  audience: string;
  expiresIn: number;
  production: boolean;
}

// Contrato de verificacao. Este servico so valida tokens, nunca assina.
export function resolveJwtContract(config: ConfigService): JwtContract {
  const production = config.get<string>('NODE_ENV') === 'production';
  const algorithm = config.get<string>('JWT_ALGORITHM') ?? (production ? undefined : 'HS256');
  const issuer =
    config.get<string>('JWT_ISSUER') ?? (production ? undefined : 'repo-auth-serverless');
  const audience =
    config.get<string>('JWT_AUDIENCE') ?? (production ? undefined : 'async-furious-project');
  const expiresInValue = config.get<string>('JWT_EXPIRES_IN') ?? (production ? undefined : '1800');
  const expiresIn = Number(expiresInValue);

  if (
    !algorithm ||
    !['HS256', 'RS256'].includes(algorithm) ||
    !issuer ||
    !audience ||
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error('JWT contract is incomplete or invalid');
  }
  if (production && (algorithm !== 'RS256' || expiresIn !== 1800)) {
    throw new Error('Production JWT requires RS256 and JWT_EXPIRES_IN=1800');
  }

  return { algorithm: algorithm as JwtAlgorithm, issuer, audience, expiresIn, production };
}
