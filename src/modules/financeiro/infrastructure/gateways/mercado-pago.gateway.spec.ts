import { BadGatewayException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  MercadoPagoConfig,
  MPNotFoundError,
  Payment,
  PaymentRefund,
  Preference,
} from 'mercadopago';
import { MercadoPagoGateway } from './mercado-pago.gateway';

jest.mock('mercadopago', () => {
  class MPNotFoundError extends Error {}
  return {
    MercadoPagoConfig: jest.fn(),
    MPNotFoundError,
    Payment: jest.fn(),
    PaymentRefund: jest.fn(),
    Preference: jest.fn(),
  };
});

describe('MercadoPagoGateway', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const create = jest.fn();
  const get = jest.fn();
  const total = jest.fn();
  const env: Record<string, string | undefined> = {};
  const config = { get: (chave: string) => env[chave] } as unknown as ConfigService;
  const gateway = new MercadoPagoGateway(config);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (Preference as unknown as jest.Mock).mockImplementation(() => ({ create }));
    (Payment as unknown as jest.Mock).mockImplementation(() => ({ get }));
    (PaymentRefund as unknown as jest.Mock).mockImplementation(() => ({ total }));
    env.MP_ACCESS_TOKEN = 'TEST-token';
    env.MP_NOTIFICATION_URL = 'https://billing/api/v1/webhooks/mercado-pago';
    delete env.MP_PREFERENCE_EXPIRACAO_HORAS;
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

  describe('expiration_date_to (prazo do detector de OS parada)', () => {
    const agora = new Date('2026-10-27T12:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers({ now: agora });
      create.mockResolvedValue({ id: 'pref-1', init_point: 'https://mp/pref-1' });
    });
    afterEach(() => jest.useRealTimers());

    const corpo = async () => {
      await gateway.criarCobranca(ordemServicoId, 10);
      return create.mock.calls[0][0].body;
    };

    it('padrão de 48 h quando MP_PREFERENCE_EXPIRACAO_HORAS não está definida', async () => {
      const body = await corpo();
      expect(body.expires).toBe(true);
      expect(body.expiration_date_to).toBe('2026-10-29T12:00:00.000+00:00');
    });

    it('usa o prazo configurado por env (horas, inclusive fracionadas)', async () => {
      env.MP_PREFERENCE_EXPIRACAO_HORAS = '0.5';
      const body = await corpo();
      expect(body.expiration_date_to).toBe('2026-10-27T12:30:00.000+00:00');
    });

    it.each(['abc', '0', '-5', 'Infinity'])(
      'valor inválido %p cai no padrão de 48 h e avisa no log',
      async (invalido) => {
        const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        env.MP_PREFERENCE_EXPIRACAO_HORAS = invalido;

        const body = await corpo();

        expect(body.expiration_date_to).toBe('2026-10-29T12:00:00.000+00:00');
        expect(aviso).toHaveBeenCalledWith(
          expect.stringContaining('MP_PREFERENCE_EXPIRACAO_HORAS')
        );
      }
    );
  });

  it('usa timeout curto e 1 retry nas chamadas ao Mercado Pago', async () => {
    create.mockResolvedValue({ id: 'pref-1', init_point: 'https://mp/pref-1' });

    await gateway.criarCobranca(ordemServicoId, 10);

    expect(MercadoPagoConfig).toHaveBeenCalledWith({
      accessToken: 'TEST-token',
      options: { timeout: 5000, maxRetries: 1 },
    });
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

  describe('consultarPagamento', () => {
    it('reconsulta o pagamento e devolve status, referência e valor', async () => {
      get.mockResolvedValue({
        id: 184177738229,
        status: 'approved',
        external_reference: ordemServicoId,
        transaction_amount: 770.5,
      });

      await expect(gateway.consultarPagamento('184177738229')).resolves.toEqual({
        id: '184177738229',
        status: 'approved',
        referenciaExterna: ordemServicoId,
        valor: 770.5,
      });
      expect(get).toHaveBeenCalledWith({ id: '184177738229' });
    });

    it('campos ausentes viram valores neutros (sem valor, nunca confirma)', async () => {
      get.mockResolvedValue({});

      await expect(gateway.consultarPagamento('99')).resolves.toEqual({
        id: '99',
        status: '',
        referenciaExterna: null,
        valor: null,
      });
    });

    it('404 do Mercado Pago (pagamento inexistente) vira null', async () => {
      get.mockRejectedValue(new (MPNotFoundError as unknown as new () => Error)());
      await expect(gateway.consultarPagamento('1')).resolves.toBeNull();
    });

    it.each([new Error('timeout'), { status: 500 }])('outra falha vira 502: %p', async (erro) => {
      get.mockRejectedValue(erro);
      await expect(gateway.consultarPagamento('1')).rejects.toThrow(BadGatewayException);
    });

    it('sem MP_ACCESS_TOKEN vira 502 sem chamar o Mercado Pago', async () => {
      delete env.MP_ACCESS_TOKEN;
      await expect(gateway.consultarPagamento('1')).rejects.toThrow(BadGatewayException);
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe('estornar', () => {
    it('faz estorno total com chave de idempotência determinística', async () => {
      total.mockResolvedValue({ id: 1 });

      await expect(gateway.estornar('184177738229')).resolves.toBeUndefined();
      expect(total).toHaveBeenCalledWith({
        payment_id: '184177738229',
        requestOptions: { idempotencyKey: 'estorno-184177738229' },
      });
    });

    it.each([new Error('timeout'), { status: 500 }])(
      'falha no estorno vira 502: %p',
      async (erro) => {
        total.mockRejectedValue(erro);
        await expect(gateway.estornar('1')).rejects.toThrow(BadGatewayException);
      }
    );
  });
});
