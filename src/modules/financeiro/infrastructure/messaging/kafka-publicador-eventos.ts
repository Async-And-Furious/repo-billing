import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, type Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import type {
  EventoBilling,
  IPublicadorEventos,
} from '../../domain/interfaces/financeiro.interfaces';

export const BILLING_TOPIC = 'billing.eventos.v1';
export const BILLING_PRODUCER_OPTIONS = {
  idempotent: true,
  allowAutoTopicCreation: false,
} as const;

export const billingKafkaSendRequest = (topic: string, key: string | null, envelope: unknown) => ({
  topic,
  acks: -1 as const,
  messages: [{ key, value: JSON.stringify(envelope) }],
});

export function billingKafkaConfig(env: NodeJS.ProcessEnv = process.env) {
  const username = env.KAFKA_SASL_USERNAME;
  const password = env.KAFKA_SASL_PASSWORD;
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('KAFKA_SASL_USERNAME e KAFKA_SASL_PASSWORD devem ser configurados juntos.');
  }
  return {
    clientId: 'billing-service',
    brokers: (env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((v) => v.trim()),
    ...(username && password ? { sasl: { mechanism: 'plain' as const, username, password } } : {}),
  };
}

export function billingEventEnvelope(evento: EventoBilling, eventId = randomUUID()) {
  const { ordemServicoId, eventType, ...data } = evento;
  return {
    eventId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    correlationId: ordemServicoId,
    producer: 'billing-service',
    data: { ordemServicoId, ...data },
  };
}

@Injectable()
export class KafkaPublicadorEventos implements IPublicadorEventos, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaPublicadorEventos.name);
  private readonly producer: Producer;
  private connected = false;

  constructor() {
    const kafka = new Kafka(billingKafkaConfig());
    this.producer = kafka.producer(BILLING_PRODUCER_OPTIONS);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.producer.connect();
    this.connected = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
  }

  async publicar(evento: EventoBilling): Promise<void> {
    const { ordemServicoId, eventType } = evento;
    await this.publicarEnvelope(BILLING_TOPIC, ordemServicoId, billingEventEnvelope(evento));
    this.logger.log({ eventType, ordemServicoId }, 'Evento billing publicado');
  }

  async publicarEnvelope(topic: string, key: string | null, envelope: unknown): Promise<void> {
    await this.producer.send(billingKafkaSendRequest(topic, key, envelope));
  }
}
