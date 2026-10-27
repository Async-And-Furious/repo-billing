import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertAuthenticated, isPublicRoute } from './public-route.util';

describe('public-route.util', () => {
  const context = { getHandler: jest.fn(), getClass: jest.fn() } as unknown as ExecutionContext;

  it('isPublicRoute reflete o metadata', () => {
    const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
    (reflector.getAllAndOverride as jest.Mock)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(undefined);
    expect(isPublicRoute(reflector, context)).toBe(true);
    expect(isPublicRoute(reflector, context)).toBe(false);
  });

  it('assertAuthenticated devolve o usuario', () => {
    expect(assertAuthenticated(null, { id: '1' })).toEqual({ id: '1' });
  });

  it('assertAuthenticated lanca 401 sem usuario', () => {
    expect(() => assertAuthenticated(null, undefined)).toThrow(UnauthorizedException);
  });

  it('assertAuthenticated repassa o erro original', () => {
    const err = new Error('falhou');
    expect(() => assertAuthenticated(err, { id: '1' })).toThrow(err);
  });
});
