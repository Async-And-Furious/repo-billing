import { IncomingMessage } from 'node:http';
import { logContext, pinoHttpOptions, resolveCorrelationId } from './pino-logger.config';

describe('pino-logger.config', () => {
  it('reaproveita x-correlation-id valido', () => {
    const req = { headers: { 'x-correlation-id': 'abc-123' } } as unknown as IncomingMessage;
    expect(resolveCorrelationId(req)).toBe('abc-123');
  });

  it('gera id quando o header e invalido', () => {
    const req = { headers: { 'x-correlation-id': 'a b' } } as unknown as IncomingMessage;
    expect(resolveCorrelationId(req)).not.toBe('a b');
  });

  it('logContext preserva ordemServicoId e eventId', () => {
    expect(logContext({ ordemServicoId: 'os-1', eventId: 'ev-1' })).toEqual({
      ordemServicoId: 'os-1',
      eventId: 'ev-1',
    });
  });
});

describe('pinoHttpOptions', () => {
  const req = { headers: { 'x-correlation-id': 'corr-9' }, id: 'corr-9' } as never;

  it('genReqId propaga o correlation id no header da resposta', () => {
    const setHeader = jest.fn();
    const id = pinoHttpOptions.genReqId?.(req, { setHeader } as never);
    expect(id).toBe('corr-9');
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'corr-9');
  });

  it('customProps expoe correlationId', () => {
    expect(pinoHttpOptions.customProps?.(req, {} as never)).toEqual({ correlationId: 'corr-9' });
  });

  it('customLogLevel varia com o status', () => {
    const level = pinoHttpOptions.customLogLevel!;
    expect(level(req, { statusCode: 200 } as never, undefined)).toBe('info');
    expect(level(req, { statusCode: 404 } as never, undefined)).toBe('warn');
    expect(level(req, { statusCode: 503 } as never, undefined)).toBe('error');
    expect(level(req, { statusCode: 200 } as never, new Error('x'))).toBe('error');
  });
});
