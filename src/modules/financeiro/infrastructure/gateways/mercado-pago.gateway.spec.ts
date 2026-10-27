import { BadGatewayException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Preference } from 'mercadopago';
import { MercadoPagoGateway } from './mercado-pago.gateway';

jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  Preference: jest.fn(),
}));

describe('MercadoPagoGateway', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const create = jest.fn();
  const env: Record<string, string | undefined> = {};
  const config = { get: (chave: string) => env[chave] } as unknown as ConfigService;
  const gateway = new MercadoPagoGateway(config);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (Preference as unknown as jest.Mock).mockImplementation(() => ({ create }));
    env.MP_ACCESS_TOKEN = 'TEST-token';
    env.MP_NOTIFICATION_URL = 'https://billing/api/v1/webhooks/mercado-pago';
  });

  it('cria preference com um item agregado da OS, sem payer', async () => {
    create.mockResolvedValue({ id: 'pref-1', init_point: 'https://mp/pref-1' });

    await expect(gateway.criarCobranca(ordemServicoId, 770.5)).resolves.toEqual({
      preferenceId: 'pref-1',
      linkPagamento: 'https://mp/pref-1',
    });

    const { body } = create.mock.calls[0][0];
    expect(body.items).toEqual([
      {
        id: ordemServicoId,
        title: `OS ${ordemServicoId}`,
        quantity: 1,
        unit_price: 770.5,
        currency_id: 'BRL',
      },
    ]);
    expect(body.external_reference).toBe(ordemServicoId);
    expect(body.notification_url).toBe(env.MP_NOTIFICATION_URL);
    expect(body).not.toHaveProperty('payer');
  });

  it('omite notification_url quando não configurada', async () => {
    env.MP_NOTIFICATION_URL = '';
    create.mockResolvedValue({ id: 'pref-1', init_point: 'https://mp/pref-1' });

    await gateway.criarCobranca(ordemServicoId, 10);
    expect(create.mock.calls[0][0].body.notification_url).toBeUndefined();
  });

  it('erro do Mercado Pago vira 502', async () => {
    create.mockRejectedValue(new Error('timeout'));
    await expect(gateway.criarCobranca(ordemServicoId, 10)).rejects.toThrow(BadGatewayException);
  });

  it('erro não-Error do SDK também vira 502', async () => {
    create.mockRejectedValue({ status: 500 });
    await expect(gateway.criarCobranca(ordemServicoId, 10)).rejects.toThrow(BadGatewayException);
  });

  it('preference sem init_point vira 502', async () => {
    create.mockResolvedValue({ id: 'pref-1' });
    await expect(gateway.criarCobranca(ordemServicoId, 10)).rejects.toThrow(BadGatewayException);
  });

  it('sem MP_ACCESS_TOKEN vira 502 sem chamar o Mercado Pago', async () => {
    delete env.MP_ACCESS_TOKEN;
    await expect(gateway.criarCobranca(ordemServicoId, 10)).rejects.toThrow(BadGatewayException);
    expect(create).not.toHaveBeenCalled();
  });
});
