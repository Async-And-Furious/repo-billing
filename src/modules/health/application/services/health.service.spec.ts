import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';
import type { PrismaService } from '../../../../shared/infrastructure/database/prisma.service';

describe('HealthService', () => {
  const queryRaw = jest.fn();
  const service = new HealthService({ $queryRaw: queryRaw } as unknown as PrismaService);

  it('check e live devolvem status ok', () => {
    expect(service.check()).toMatchObject({ status: 'ok' });
    expect(service.live().status).toBe('ok');
  });

  it('ready devolve ok quando o banco responde', async () => {
    queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(service.ready()).resolves.toMatchObject({ status: 'ok' });
  });

  it('ready lanca 503 quando o banco falha', async () => {
    queryRaw.mockRejectedValueOnce(new Error('down'));
    await expect(service.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
