import { DomainException } from '../src/shared/domain/exceptions/domain.exception';
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
    const orcamento = { handle: jest.fn().mockResolvedValue('GERADO') };
    const compensar = { execute: jest.fn().mockResolvedValue(undefined) };
    const publicador = {
      publicar: jest.fn().mockResolvedValue(undefined),
      publicarEnvelope: jest.fn().mockResolvedValue(undefined),
    };
    const wait = jest.fn().mockResolvedValue(undefined);
    const processor = new BillingEventProcessor(
      orcamento as never,
      compensar as never,
      publicador as never,
      () => now,
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

    await processor.process('os.eventos.v1', 'os-1', message(envelope()));

    expect(orcamento.handle).toHaveBeenCalledWith(envelope().data);
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

  it('publishes business validation failures as EtapaDaSagaFalhou without retry', async () => {
    const { processor, orcamento, publicador } = setup();
    orcamento.handle.mockRejectedValue(new DomainException('totais inválidos'));

    await processor.process('os.eventos.v1', 'os-1', message(envelope()));

    expect(publicador.publicar).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'EtapaDaSagaFalhou',
        ordemServicoId: 'os-1',
        servicoOrigem: 'billing-service',
        eventTypeOriginal: 'OrcamentoCalculado',
        etapa: 'orcamento',
        motivo: 'totais inválidos',
      })
    );
    expect(publicador.publicarEnvelope).not.toHaveBeenCalled();
  });

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
    await processor.process(
      BILLING_DLT_TOPIC,
      'os-1',
      message(
        envelope({
          eventType: 'EtapaDaSagaFalhou',
          data: { ordemServicoId: 'os-1', etapa: 'orcamento' },
        })
      )
    );
    expect(publicador.publicar).not.toHaveBeenCalled();
    expect(compensar.execute).not.toHaveBeenCalled();
  });

  it('sends malformed envelopes to DLT without logging or persisting raw payload', async () => {
    const { processor, publicador } = setup();
    await processor.process('os.eventos.v1', 'os-1', Buffer.from('{not-json}'));
    const [, , failure] = publicador.publicarEnvelope.mock.calls[0];
    expect(failure).toMatchObject({ eventType: 'InvalidEnvelope', retry: { attempt: 3 } });
    expect(failure).not.toHaveProperty('rawPayload');
  });

  it('waits until notBefore when consuming a retry message', async () => {
    const { processor, wait } = setup();
    const retryEnvelope = envelope({
      retry: {
        attempt: 1,
        firstFailedAt: now.toISOString(),
        notBefore: '2026-11-01T12:00:30.000Z',
      },
    });
    await processor.process(BILLING_RETRY_TOPIC, 'os-1', message(retryEnvelope));
    expect(wait).toHaveBeenCalledWith(30_000);
  });
});
