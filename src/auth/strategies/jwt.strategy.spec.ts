import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { Role } from '../enums/role.enum';
import type { JwtPayload } from '../types/auth.types';

describe('JwtStrategy', () => {
  const strategy = new JwtStrategy(
    new ConfigService({ JWT_SECRET: 'test-secret', NODE_ENV: 'test' })
  );
  const base: JwtPayload = { sub: 'user-1', iss: 'iss', aud: 'aud', exp: 9999999999 };

  it('devolve id, email e role dos claims', () => {
    expect(strategy.validate({ ...base, email: 'a@b.com', role: Role.MECANICO })).toEqual({
      id: 'user-1',
      email: 'a@b.com',
      role: Role.MECANICO,
    });
  });

  it('token sem role vira CLIENTE', () => {
    expect(strategy.validate(base).role).toBe(Role.CLIENTE);
  });

  it('rejeita role fora do enum', () => {
    expect(() => strategy.validate({ ...base, role: 'ROOT' as Role })).toThrow(
      UnauthorizedException
    );
  });

  it('rejeita payload sem sub', () => {
    expect(() => strategy.validate({ ...base, sub: ' ' })).toThrow(UnauthorizedException);
  });
});
