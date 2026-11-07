import { HttpException, Injectable, ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { AuthenticatedThrottlerGuard } from './authenticated-throttler.guard';

@Injectable()
export class JwtAndThrottlingGuard {
  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly throttler: AuthenticatedThrottlerGuard
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await this.jwt.canActivate(context);
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() !== 401) throw error;
      await this.throttler.canActivate(context);
      throw error;
    }
    return this.throttler.canActivate(context);
  }
}
