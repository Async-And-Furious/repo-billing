import { ConfigService } from '@nestjs/config';
import { resolveJwtContract } from './jwt.config';

const cfg = (values: Record<string, string>): ConfigService => new ConfigService(values);

describe('resolveJwtContract', () => {
  // O ConfigService le process.env antes dos valores injetados; o jest define NODE_ENV=test.
  const originalEnv = process.env.NODE_ENV;
  const setEnv = (value: string): void => {
    process.env.NODE_ENV = value;
  };
  afterEach(() => setEnv(originalEnv as string));

  it('usa defaults locais fora de producao', () => {
    expect(resolveJwtContract(cfg({}))).toEqual({
      algorithm: 'HS256',
      issuer: 'repo-auth-serverless',
      audience: 'async-furious-project',
      expiresIn: 1800,
      production: false,
    });
  });

  it('aceita RS256 em producao com expiracao de 1800s', () => {
    setEnv('production');
    const c = resolveJwtContract(
      cfg({
        NODE_ENV: 'production',
        JWT_ALGORITHM: 'RS256',
        JWT_ISSUER: 'i',
        JWT_AUDIENCE: 'a',
        JWT_EXPIRES_IN: '1800',
      })
    );
    expect(c.production).toBe(true);
  });

  it('falha em producao sem contrato completo', () => {
    setEnv('production');
    expect(() => resolveJwtContract(cfg({ NODE_ENV: 'production' }))).toThrow('incomplete');
  });

  it('falha em producao com HS256', () => {
    setEnv('production');
    expect(() =>
      resolveJwtContract(
        cfg({
          NODE_ENV: 'production',
          JWT_ALGORITHM: 'HS256',
          JWT_ISSUER: 'i',
          JWT_AUDIENCE: 'a',
          JWT_EXPIRES_IN: '1800',
        })
      )
    ).toThrow('Production JWT requires RS256');
  });

  it('falha com algoritmo ou expiracao invalidos', () => {
    expect(() => resolveJwtContract(cfg({ JWT_ALGORITHM: 'none' }))).toThrow('invalid');
    expect(() => resolveJwtContract(cfg({ JWT_EXPIRES_IN: '-1' }))).toThrow('invalid');
  });
});
