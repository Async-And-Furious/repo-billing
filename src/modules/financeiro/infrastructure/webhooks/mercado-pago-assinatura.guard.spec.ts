import { createHmac } from 'node:crypto';
import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MercadoPagoAssinaturaGuard } from './mercado-pago-assinatura.guard';

describe('MercadoPagoAssinaturaGuard', () => {
  const chaveDeTeste = 'chave-de-teste';
  const dataId = '184177738229';
  const requestId = 'req-1';
  const env: Record<string, string | undefined> = {};
  const config = { get: (nome: string) => env[nome] } as unknown as ConfigService;
  const guard = new MercadoPagoAssinaturaGuard(config);

  // Assinatura no formato documentado pelo Mercado Pago: HMAC-SHA256 do manifesto com a chave.
  const assinar = (id: string, reqId: string, chave = chaveDeTeste): string => {
    const ts = String(Date.now());
    const v1 = createHmac('sha256', chave)
      .update(`id:${id};request-id:${reqId};ts:${ts};`)
      .digest('hex');
    return `ts=${ts},v1=${v1}`;
  };

  const contexto = (
    query: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ query, header: (nome: string) => headers[nome] }),
      }),
    }) as unknown as ExecutionContext;

  const notificacao = { type: 'payment', 'data.id': dataId };

  beforeEach(() => {
    env['MP_WEBHOOK_SECRET'] = chaveDeTeste;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('aceita assinatura válida com o data.id da query string', () => {
    const headers = { 'x-signature': assinar(dataId, requestId), 'x-request-id': requestId };
    expect(guard.canActivate(contexto(notificacao, headers))).toBe(true);
  });

  it('recusa assinatura ausente com 401', () => {
    expect(() => guard.canActivate(contexto(notificacao))).toThrow(UnauthorizedException);
  });

  it('recusa assinatura calculada com outra chave com 401', () => {
    const headers = {
      'x-signature': assinar(dataId, requestId, 'outra-chave'),
      'x-request-id': requestId,
    };
    expect(() => guard.canActivate(contexto(notificacao, headers))).toThrow(UnauthorizedException);
  });

  it('recusa assinatura de outro data.id (consulta adulterada) com 401', () => {
    const headers = { 'x-signature': assinar('999', requestId), 'x-request-id': requestId };
    expect(() => guard.canActivate(contexto(notificacao, headers))).toThrow(UnauthorizedException);
  });

  it('recusa assinatura mal formada com 401', () => {
    const headers = { 'x-signature': 'lixo', 'x-request-id': requestId };
    expect(() => guard.canActivate(contexto(notificacao, headers))).toThrow(UnauthorizedException);
  });

  it('sem a chave configurada recusa tudo que altera estado, mesmo com assinatura', () => {
    delete env['MP_WEBHOOK_SECRET'];
    const headers = { 'x-signature': assinar(dataId, requestId), 'x-request-id': requestId };
    expect(() => guard.canActivate(contexto(notificacao, headers))).toThrow(UnauthorizedException);
  });

  it.each([
    ['IPN legado (?id=&topic=)', { id: '1', topic: 'payment' }],
    ['merchant_order', { type: 'topic_merchant_order_wh', 'data.id': '1' }],
    ['type=payment sem data.id', { type: 'payment' }],
  ])('deixa passar sem checar assinatura o que não altera estado: %s', (_nome, query) => {
    expect(guard.canActivate(contexto(query))).toBe(true);
  });

  it('recusa data.id repetido na query com 401', () => {
    const headers = { 'x-signature': assinar(dataId, requestId), 'x-request-id': requestId };
    const ctx = contexto({ type: 'payment', 'data.id': [dataId, '999'] }, headers);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
