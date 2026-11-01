import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, type Consumer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';
import { CompensarFalhaSagaHandler } from '../../application/event-handlers/compensar-falha-saga.handler';
import { GerarOrcamentoHandler } from '../../application/event-handlers/gerar-orcamento.handler';
import type { OrcamentoCalculado } from '../../domain/events/orcamento.events';
import { EtapaDaSagaFalhou } from '../../domain/events/etapa-da-saga-falhou.event';
import { KafkaPublicadorEventos, billingKafkaConfig } from './kafka-publicador-eventos';

export const BILLING_CONSUMER_GROUP = 'billing-consumer';
export const BILLING_RETRY_TOPIC = 'billing.retry.v1';
export const BILLING_DLT_TOPIC = 'billing.dlt.v1';
export const BILLING_SUBSCRIPTIONS = [
  { topic: 'os.eventos.v1', fromBeginning: false },
  { topic: 'execucao.eventos.v1', fromBeginning: false },
  { topic: BILLING_RETRY_TOPIC, fromBeginning: true },
  { topic: BILLING_DLT_TOPIC, fromBeginning: true },
] as const;

const MAX_TENTATIVAS = 3;
const BACKOFF_MS = [30_000, 60_000];

interface RetryMetadata {
  attempt: number;
  firstFailedAt: string;
  notBefore: string;
}

interface EventEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  correlationId: string;
  producer: string;
  data: Record<string, unknown>;
  retry?: RetryMetadata;
  lastError?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : 'Falha desconhecida')
    .replace(/\s+/g, ' ')
    .slice(0, 500);

const parseEnvelope = (value: Buffer | null): EventEnvelope => {
  if (!value) throw new Error('Mensagem Kafka sem payload.');
  const parsed: unknown = JSON.parse(value.toString());
  if (
    !isRecord(parsed) ||
    typeof parsed.eventId !== 'string' ||
    typeof parsed.eventType !== 'string' ||
    typeof parsed.eventVersion !== 'number' ||
    !Number.isInteger(parsed.eventVersion) ||
    parsed.eventVersion < 1 ||
    typeof parsed.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.occurredAt)) ||
    typeof parsed.correlationId !== 'string' ||
    typeof parsed.producer !== 'string' ||
    !isRecord(parsed.data)
  ) {
    throw new Error('Envelope Kafka inválido.');
  }
  if (
    parsed.retry !== undefined &&
    (!isRecord(parsed.retry) ||
      typeof parsed.retry.attempt !== 'number' ||
      !Number.isInteger(parsed.retry.attempt) ||
      parsed.retry.attempt < 1 ||
      parsed.retry.attempt > MAX_TENTATIVAS ||
      typeof parsed.retry.firstFailedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.retry.firstFailedAt)) ||
      typeof parsed.retry.notBefore !== 'string' ||
      !Number.isFinite(Date.parse(parsed.retry.notBefore)))
  ) {
    throw new Error('Metadados de retry inválidos.');
  }
  if (parsed.lastError !== undefined && typeof parsed.lastError !== 'string') {
    throw new Error('Campo lastError inválido.');
  }
  return parsed as unknown as EventEnvelope;
};

const isOrcamentoCalculado = (
  data: Record<string, unknown>
): data is Record<string, unknown> & OrcamentoCalculado =>
  typeof data.ordemServicoId === 'string' &&
  typeof data.valorTotalServicos === 'number' &&
  typeof data.valorTotalPecas === 'number' &&
  typeof data.valorTotalGeral === 'number';

type SagaFailureData = {
  ordemServicoId: string;
  servicoOrigem: string;
  eventTypeOriginal: string | null;
  etapa: string;
  motivo: string;
};

const isEtapaDaSagaFalhou = (
  data: Record<string, unknown>
): data is Record<string, unknown> & SagaFailureData =>
  typeof data.ordemServicoId === 'string' &&
  typeof data.servicoOrigem === 'string' &&
  (typeof data.eventTypeOriginal === 'string' || data.eventTypeOriginal === null) &&
  typeof data.etapa === 'string' &&
  typeof data.motivo === 'string';

type Wait = (milliseconds: number) => Promise<void>;

export class BillingEventProcessor {
  private readonly logger = new Logger(BillingEventProcessor.name);

  constructor(
    private readonly orcamento: GerarOrcamentoHandler,
    private readonly compensar: CompensarFalhaSagaHandler,
    private readonly publicador: KafkaPublicadorEventos,
    private readonly now: () => Date = () => new Date(),
    private readonly wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async process(topic: string, key: string | null, value: Buffer | null): Promise<void> {
    let envelope: EventEnvelope;
    try {
      envelope = parseEnvelope(value);
    } catch (error) {
      if (topic === BILLING_DLT_TOPIC) {
        this.logger.error(
          { topic, key, error: errorText(error) },
          'Mensagem inválida retida na DLT'
        );
        return;
      }
      const eventId = randomUUID();
      const now = this.now().toISOString();
      await this.publicador.publicarEnvelope(BILLING_DLT_TOPIC, key, {
        eventId,
        eventType: 'InvalidEnvelope',
        eventVersion: 1,
        occurredAt: now,
        correlationId: key ?? eventId,
        producer: 'billing-service',
        data: {},
        retry: { attempt: MAX_TENTATIVAS, firstFailedAt: now, notBefore: now },
        lastError: errorText(error),
      });
      return;
    }

    if (topic === BILLING_RETRY_TOPIC && envelope.retry) {
      const remaining = Date.parse(envelope.retry.notBefore) - this.now().getTime();
      // shortcut: waiting blocks other keys in this partition; use partition pause/resume if retry volume causes head-of-line delay.
      if (Number.isFinite(remaining) && remaining > 0) await this.wait(remaining);
    }

    try {
      if (topic === BILLING_DLT_TOPIC) {
        this.validateKeyAndCorrelation(envelope, key);
        await this.processDeadLetter(envelope);
      } else {
        this.validateKeyAndCorrelation(envelope, key);
        await this.dispatch(envelope);
      }
      this.logConsumed(topic, envelope);
    } catch (error) {
      if (topic === BILLING_DLT_TOPIC) {
        this.logger.error(
          {
            eventId: envelope.eventId,
            correlationId: envelope.correlationId,
            ordemServicoId: envelope.data.ordemServicoId,
            eventType: envelope.eventType,
            error: errorText(error),
          },
          'Falha ao processar mensagem na DLT'
        );
        throw error;
      }
      if (error instanceof DomainException && envelope.eventType === 'OrcamentoCalculado') {
        const ordemServicoId = envelope.data.ordemServicoId;
        if (typeof ordemServicoId === 'string') {
          try {
            await this.publicador.publicar(
              new EtapaDaSagaFalhou(
                ordemServicoId,
                'billing-service',
                envelope.eventType,
                'orcamento',
                errorText(error)
              )
            );
            this.logConsumed(topic, envelope);
            return;
          } catch (publishError) {
            this.logFailure(topic, envelope, publishError);
            await this.scheduleRetry(topic, key, envelope, publishError);
            return;
          }
        }
      }
      this.logFailure(topic, envelope, error);
      await this.scheduleRetry(topic, key, envelope, error);
    }
  }

  private async dispatch(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType === 'OrcamentoCalculado') {
      if (envelope.eventVersion !== 1)
        throw new Error('Versão não suportada de OrcamentoCalculado.');
      if (!isOrcamentoCalculado(envelope.data)) {
        throw new DomainException('Payload inválido de OrcamentoCalculado.');
      }
      await this.orcamento.handle(envelope.data);
      return;
    }
    if (envelope.eventType === 'EtapaDaSagaFalhou') {
      if (envelope.eventVersion !== 1)
        throw new Error('Versão não suportada de EtapaDaSagaFalhou.');
      if (!isEtapaDaSagaFalhou(envelope.data)) {
        throw new Error('Payload inválido de EtapaDaSagaFalhou.');
      }
      await this.compensar.execute({
        ordemServicoId: envelope.data.ordemServicoId,
        etapa: envelope.data.etapa,
      });
      return;
    }
    this.logger.debug(
      { eventId: envelope.eventId, eventType: envelope.eventType },
      'Evento ignorado'
    );
  }

  private validateKeyAndCorrelation(envelope: EventEnvelope, key: string | null): void {
    if (!['OrcamentoCalculado', 'EtapaDaSagaFalhou'].includes(envelope.eventType)) return;
    const ordemServicoId = envelope.data.ordemServicoId;
    if (
      typeof ordemServicoId !== 'string' ||
      envelope.correlationId !== ordemServicoId ||
      key !== ordemServicoId
    ) {
      throw new Error('ordemServicoId, correlationId e chave Kafka devem ser iguais.');
    }
  }

  private async processDeadLetter(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType === 'EtapaDaSagaFalhou') return;
    if (envelope.eventType !== 'OrcamentoCalculado') return;
    const ordemServicoId = envelope.data.ordemServicoId;
    if (typeof ordemServicoId !== 'string') return;
    await this.publicador.publicar(
      new EtapaDaSagaFalhou(
        ordemServicoId,
        'billing-service',
        envelope.eventType,
        'orcamento',
        envelope.lastError ?? 'Falha técnica após três tentativas.'
      )
    );
  }

  private logConsumed(topic: string, envelope: EventEnvelope): void {
    this.logger.log(
      {
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        ordemServicoId: envelope.data.ordemServicoId ?? null,
        eventType: envelope.eventType,
        topic,
      },
      'Evento billing consumido'
    );
  }

  private logFailure(topic: string, envelope: EventEnvelope, error: unknown): void {
    this.logger.warn(
      {
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        ordemServicoId: envelope.data.ordemServicoId ?? null,
        eventType: envelope.eventType,
        topic,
        error: errorText(error),
      },
      'Falha no processamento; mensagem será retentada'
    );
  }

  private async scheduleRetry(
    topic: string,
    key: string | null,
    envelope: EventEnvelope,
    error: unknown
  ): Promise<void> {
    const attempt = (topic === BILLING_RETRY_TOPIC ? (envelope.retry?.attempt ?? 0) : 0) + 1;
    const now = this.now();
    const firstFailedAt = envelope.retry?.firstFailedAt ?? now.toISOString();
    const backoff = BACKOFF_MS[attempt - 1] ?? 0;
    const retry = {
      ...envelope,
      retry: {
        attempt: Math.min(attempt, MAX_TENTATIVAS),
        firstFailedAt,
        notBefore: new Date(now.getTime() + backoff).toISOString(),
      },
    };
    if (attempt >= MAX_TENTATIVAS) {
      await this.publicador.publicarEnvelope(BILLING_DLT_TOPIC, key, {
        ...retry,
        lastError: errorText(error),
      });
      return;
    }
    await this.publicador.publicarEnvelope(BILLING_RETRY_TOPIC, key, retry);
  }
}

@Injectable()
export class KafkaConsumidorEventos implements OnModuleInit, OnModuleDestroy {
  private readonly consumer: Consumer;
  private readonly processor: BillingEventProcessor;
  private readonly kafka: Kafka;
  private connected = false;

  constructor(
    orcamento: GerarOrcamentoHandler,
    compensar: CompensarFalhaSagaHandler,
    publicador: KafkaPublicadorEventos
  ) {
    this.kafka = new Kafka(billingKafkaConfig());
    this.consumer = this.kafka.consumer({
      groupId: process.env.KAFKA_CONSUMER_GROUP || BILLING_CONSUMER_GROUP,
    });
    this.processor = new BillingEventProcessor(orcamento, compensar, publicador);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.consumer.connect();
    this.connected = true;
    for (const subscription of BILLING_SUBSCRIPTIONS) {
      await this.consumer.subscribe(subscription);
    }
    await this.consumer.run({
      // State and retry/DLT publishes finish before eachMessage resolves, so KafkaJS commits afterward.
      eachMessage: async ({ topic, message }) =>
        this.processor.process(topic, message.key?.toString() ?? null, message.value),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) await this.consumer.disconnect();
  }
}
