import { Logger } from '@nestjs/common';
import { DomainException } from '../src/shared/domain/exceptions/domain.exception';
jest.mock('newrelic', () => ({ recordCustomEvent: jest.fn() }));
const { recordCustomEvent } = jest.requireMock<{ recordCustomEvent: jest.Mock }>('newrelic');
import {
  BILLING_DLT_TOPIC,
  BILLING_RETRY_TOPIC,
  BILLING_SUBSCRIPTIONS,
  BillingEventProcessor,
} from '../src/modules/financeiro/infrastructure/messaging/kafka-consumidor-eventos';

describe('BillingEventProcessor', () => {
  const now = new Date('2026-11-01T12:00:00.000Z');
  const envelope = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'event-1',
    eventType: 'OrcamentoCalculado',
    eventVersion: 1,
    occurredAt: now.toISOString(),
    correlationId: 'os-1',
    producer: 'os-service',
    data: {
      ordemServicoId: 'os-1',
      valorTotalServicos: 10,
      valorTotalPecas: 5,
      valorTotalGeral: 15,
    },
    ...overrides,
  });

  const setup = () => {
    let clock = new Date(now);
    const orcamento = { handle: jest.fn().mockResolvedValue('GERADO') };
    const compensar = { execute: jest.fn().mockResolvedValue(undefined) };
    const publicador = {
      publicar: jest.fn().mockResolvedValue(undefined),
      publicarEnvelope: jest.fn().mockResolvedValue(undefined),
    };
    const wait = jest.fn((ms: number) => {
      clock = new Date(clock.getTime() + ms);
      return Promise.resolve();
    });
    const processor = new BillingEventProcessor(
      orcamento as never,
      compensar as never,
      publicador as never,
      () => clock,
      wait
    );
    return { processor, orcamento, compensar, publicador, wait };
  };

  const message = (value: unknown) => Buffer.from(JSON.stringify(value));

  it('starts live on source topics and drains retry/DLT backlog', () => {
    expect(BILLING_SUBSCRIPTIONS).toEqual([
      { topic: 'os.eventos.v1', fromBeginning: false },
      { topic: 'execucao.eventos.v1', fromBeginning: false },
      { topic: BILLING_RETRY_TOPIC, fromBeginning: true },
      { topic: BILLING_DLT_TOPIC, fromBeginning: true },
    ]);
  });

  it('dispatches OrcamentoCalculado to the state-idempotent budget handler', async () => {
    const { processor, orcamento } = setup();
    recordCustomEvent.mockClear();

    await processor.process('os.eventos.v1', 'os-1', message(envelope()));

    expect(orcamento.handle).toHaveBeenCalledWith(envelope().data);
    expect(recordCustomEvent).toHaveBeenCalledWith('SagaStep', {
      ordemServicoId: 'os-1',
      service: 'billing-service',
      step: 'orcamento',
      outcome: 'SUCCESS',
      durationMs: expect.any(Number),
    });
    expect(Object.keys(recordCustomEvent.mock.calls[0][1])).toEqual([
      'ordemServicoId',
      'service',
      'step',
      'outcome',
      'durationMs',
    ]);
  });

  it('re-delivers messages to the business state guard without a processed-events table', async () => {
    const { processor, orcamento } = setup();
    await processor.process('os.eventos.v1', 'os-1', message(envelope()));
    await processor.process('os.eventos.v1', 'os-1', message(envelope()));

    expect(orcamento.handle).toHaveBeenCalledTimes(2);
  });

  it.each(['os.eventos.v1', 'execucao.eventos.v1'])(
    'dispatches EtapaDaSagaFalhou received on %s',
    async (topic) => {
      const { processor, compensar } = setup();
      const evento = envelope({
        eventType: 'EtapaDaSagaFalhou',
        data: {
          ordemServicoId: 'os-1',
          servicoOrigem: 'os-service',
          eventTypeOriginal: 'OrcamentoCalculado',
          etapa: 'aprovacao-pagamento',
          motivo: 'timeout',
        },
      });

      await processor.process(topic, 'os-1', message(evento));

      expect(compensar.execute).toHaveBeenCalledWith({
        ordemServicoId: 'os-1',
        etapa: 'aprovacao-pagamento',
      });
    }
  );

  it('schedules the first retry with backoff and the original event id', async () => {
    const { processor, orcamento, publicador } = setup();
    orcamento.handle.mockRejectedValue(new Error('database unavailable'));

    await processor.process('os.eventos.v1', 'os-1', message(envelope()));

    expect(publicador.publicarEnvelope).toHaveBeenCalledWith(
      BILLING_RETRY_TOPIC,
      'os-1',
      expect.objectContaining({
        eventId: 'event-1',
        retry: {
          attempt: 1,
          firstFailedAt: now.toISOString(),
          notBefore: '2026-11-01T12:00:30.000Z',
        },
      })
    );
  });

  it('routes the third failed attempt to the DLT with lastError', async () => {
    const { processor, compensar, publicador } = setup();
    compensar.execute.mockRejectedValue(new Error('refund unavailable'));
    const retryEnvelope = envelope({
      eventType: 'EtapaDaSagaFalhou',
      data: {
        ordemServicoId: 'os-1',
        servicoOrigem: 'os-service',
        eventTypeOriginal: 'PagamentoConfirmado',
        etapa: 'inicio-execucao',
        motivo: 'failure',
      },
      retry: {
        attempt: 2,
        firstFailedAt: '2026-11-01T11:59:00.000Z',
        notBefore: now.toISOString(),
      },
    });

    await processor.process(BILLING_RETRY_TOPIC, 'os-1', message(retryEnvelope));

    expect(publicador.publicarEnvelope).toHaveBeenCalledWith(
      BILLING_DLT_TOPIC,
      'os-1',
      expect.objectContaining({
        eventId: 'event-1',
        retry: expect.objectContaining({ attempt: 3 }),
        lastError: 'refund unavailable',
      })
    );
  });

  it('publishes a saga failure from DLT and avoids a recursive EtapaDaSagaFalhou', async () => {
    const { processor, publicador, compensar } = setup();
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const successLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await processor.process(
      BILLING_DLT_TOPIC,
      'os-1',
      message(
        envelope({
          retry: { attempt: 3, firstFailedAt: now.toISOString(), notBefore: now.toISOString() },
          lastError: 'erro final',
        })
      )
    );
    expect(publicador.publicar).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'EtapaDaSagaFalhou',
        etapa: 'orcamento',
        motivo: 'erro final',
      })
    );

    publicador.publicar.mockClear();
    successLog.mockClear();
    await processor.process(
      BILLING_DLT_TOPIC,
      'os-1',
      message(
        envelope({
          eventType: 'EtapaDaSagaFalhou',
          data: {
            ordemServicoId: 'os-1',
            servicoOrigem: 'billing-service',
            eventTypeOriginal: 'OrcamentoCalculado',
            etapa: 'orcamento',
            motivo: 'falha técnica',
          },
        })
      )
    );
    expect(publicador.publicar).not.toHaveBeenCalled();
    expect(compensar.execute).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ ordemServicoId: 'os-1', etapa: 'orcamento' }),
      expect.stringContaining('compensação pendente')
    );
    expect(recordCustomEvent).toHaveBeenCalledWith('SagaStep', {
      ordemServicoId: 'os-1',
      service: 'billing-service',
      step: 'compensacao',
      outcome: 'FAILED',
      durationMs: expect.any(Number),
    });
    expect(successLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    successLog.mockRestore();
  });

  it('logs and sends malformed envelopes to DLT without retaining raw payload', async () => {
    const { processor, publicador } = setup();
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await processor.process('os.eventos.v1', 'os-1', Buffer.from('{not-json}'));
    const [, , failure] = publicador.publicarEnvelope.mock.calls[0];
    expect(failure).toMatchObject({ eventType: 'InvalidEnvelope', retry: { attempt: 3 } });
    expect(failure).not.toHaveProperty('rawPayload');
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('ignores a malformed DLT envelope without recursively publishing it', async () => {
    const { processor, publicador } = setup();
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await processor.process(BILLING_DLT_TOPIC, 'os-1', Buffer.from('{not-json}'));
    expect(publicador.publicarEnvelope).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('routes business validation errors to poison DLT, not a false saga failure', async () => {
    const { processor, orcamento, publicador } = setup();
    orcamento.handle.mockRejectedValue(new DomainException('totais inválidos'));
    await processor.process('os.eventos.v1', 'os-1', message(envelope()));
    expect(publicador.publicar).not.toHaveBeenCalled();
    expect(publicador.publicarEnvelope).toHaveBeenCalledWith(
      BILLING_DLT_TOPIC,
      'os-1',
      expect.objectContaining({ eventType: 'InvalidEnvelope', lastError: 'totais inválidos' })
    );
  });

  it('heartbeats during backoff and waits before handling a retry', async () => {
    const { processor, wait } = setup();
    recordCustomEvent.mockClear();
    const heartbeat = jest.fn().mockResolvedValue(undefined);
    const retryEnvelope = envelope({
      retry: {
        attempt: 1,
        firstFailedAt: now.toISOString(),
        notBefore: '2026-11-01T12:00:30.000Z',
      },
    });
    await processor.process(BILLING_RETRY_TOPIC, 'os-1', message(retryEnvelope), heartbeat);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000, 10_000]);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(recordCustomEvent).toHaveBeenCalledWith('SagaStep', {
      ordemServicoId: 'os-1',
      service: 'billing-service',
      step: 'orcamento',
      outcome: 'SUCCESS',
      durationMs: expect.any(Number),
    });
  });

  it('does not resolve a failed DLT publish, leaving the source offset uncommitted', async () => {
    const { processor, orcamento, publicador } = setup();
    orcamento.handle.mockRejectedValue(new Error('database unavailable'));
    publicador.publicarEnvelope.mockRejectedValue(new Error('Kafka unavailable'));
    await expect(
      processor.process(
        'os.eventos.v1',
        'os-1',
        message(
          envelope({
            retry: {
              attempt: 2,
              firstFailedAt: now.toISOString(),
              notBefore: now.toISOString(),
            },
          })
        )
      )
    ).rejects.toThrow('Kafka unavailable');
  });

  it('logs exhausted saga compensation as pending and does not publish another event', async () => {
    const { processor, publicador, compensar } = setup();
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const failedStep = envelope({
      eventType: 'EtapaDaSagaFalhou',
      data: {
        ordemServicoId: 'os-1',
        servicoOrigem: 'execucao-service',
        eventTypeOriginal: 'PagamentoConfirmado',
        etapa: 'inicio-execucao',
        motivo: 'runtime failure',
      },
      retry: { attempt: 3, firstFailedAt: now.toISOString(), notBefore: now.toISOString() },
      lastError: 'refund unavailable',
    });
    await processor.process(BILLING_DLT_TOPIC, 'os-1', message(failedStep));
    expect(compensar.execute).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ ordemServicoId: 'os-1', etapa: 'inicio-execucao' }),
      expect.stringContaining('compensação pendente')
    );
    errorLog.mockRestore();
  });
});
