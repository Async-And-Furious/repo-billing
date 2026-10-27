import { HealthController } from './health.controller';
import type { HealthService } from '../../application/services/health.service';

describe('HealthController', () => {
  const body = { status: 'ok' as const, timestamp: 't', version: '1' };
  const service = {
    check: jest.fn().mockReturnValue(body),
    live: jest.fn().mockReturnValue(body),
    ready: jest.fn().mockResolvedValue(body),
  };
  const controller = new HealthController(service as unknown as HealthService);

  it('delega para o HealthService', async () => {
    expect(controller.check()).toBe(body);
    expect(controller.live()).toBe(body);
    await expect(controller.ready()).resolves.toBe(body);
  });
});
