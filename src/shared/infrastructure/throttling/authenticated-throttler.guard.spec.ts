import { ExecutionContext, HttpException, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { AuthenticatedThrottlerGuard } from './authenticated-throttler.guard';
import { JwtAndThrottlingGuard } from './jwt-and-throttling.guard';

class TestableThrottlerGuard extends AuthenticatedThrottlerGuard {
  tracker(request: Record<string, unknown>): Promise<string> {
    return this.getTracker(request);
  }
}

const options: ThrottlerModuleOptions = [{ name: 'short', ttl: 60000, limit: 2 }];
const storage: ThrottlerStorage = { increment: jest.fn() };

describe('AuthenticatedThrottlerGuard tracker', () => {
  const guard = new TestableThrottlerGuard(options, storage, new Reflector());

  it('isolates subjects and keeps each subject bucket stable regardless of IP', async () => {
    await expect(guard.tracker({ user: { id: 'a' }, ip: '10.0.0.1' })).resolves.toBe('user:a');
    await expect(guard.tracker({ user: { id: 'a' }, ip: '10.0.0.2' })).resolves.toBe('user:a');
    await expect(guard.tracker({ user: { id: 'b' }, ip: '10.0.0.1' })).resolves.toBe('user:b');
  });

  it('ignores X-Forwarded-For and uses req.ip for public requests', async () => {
    await expect(
      guard.tracker({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } })
    ).resolves.toBe('ip:10.0.0.1');
    await expect(guard.tracker({ ip: '10.0.0.2' })).resolves.toBe('ip:10.0.0.2');
  });
});

describe('JwtAndThrottlingGuard failures', () => {
  const context = {} as ExecutionContext;
  const jwt = { canActivate: jest.fn<Promise<boolean>, [ExecutionContext]>() };
  const throttler = { canActivate: jest.fn<Promise<boolean>, [ExecutionContext]>() };
  const guard = new JwtAndThrottlingGuard(
    jwt as unknown as JwtAuthGuard,
    throttler as unknown as AuthenticatedThrottlerGuard
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.canActivate.mockResolvedValue(true);
    throttler.canActivate.mockResolvedValue(true);
  });

  it('charges invalid JWT once by invoking the throttler once and rethrows same 401', async () => {
    const unauthorized = new HttpException('unauthorized', 401);
    jwt.canActivate.mockRejectedValue(unauthorized);

    await expect(guard.canActivate(context)).rejects.toBe(unauthorized);
    expect(throttler.canActivate).toHaveBeenCalledTimes(1);
  });

  it('propagates 429 when invalid JWT has exceeded the IP limit', async () => {
    jwt.canActivate.mockRejectedValue(new HttpException('unauthorized', 401));
    const limited = new HttpException('too many requests', 429);
    throttler.canActivate.mockRejectedValue(limited);

    await expect(guard.canActivate(context)).rejects.toBe(limited);
    expect(throttler.canActivate).toHaveBeenCalledTimes(1);
  });

  it('does not charge or convert non-401 errors', async () => {
    const internal = new InternalServerErrorException();
    jwt.canActivate.mockRejectedValue(internal);

    await expect(guard.canActivate(context)).rejects.toBe(internal);
    expect(throttler.canActivate).not.toHaveBeenCalled();
  });
});
