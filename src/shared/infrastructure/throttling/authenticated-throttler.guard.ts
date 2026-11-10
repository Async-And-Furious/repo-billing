import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  getOptionsToken,
  getStorageToken,
  ThrottlerGuard,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

@Injectable()
export class AuthenticatedThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
    reflector: Reflector
  ) {
    super(options, storage, reflector);
  }

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: unknown } | undefined;
    return Promise.resolve(
      typeof user?.id === 'string' ? `user:${user.id}` : `ip:${String(req.ip)}`
    );
  }
}
