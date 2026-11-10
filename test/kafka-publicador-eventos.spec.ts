import { OrcamentoGerado } from '../src/modules/financeiro/domain/events/orcamento.events';
import {
  BILLING_PRODUCER_OPTIONS,
  billingEventEnvelope,
  billingKafkaConfig,
  billingKafkaSendRequest,
  BILLING_TOPIC,
} from '../src/modules/financeiro/infrastructure/messaging/kafka-publicador-eventos';

describe('Billing Kafka adapter contract', () => {
  it('uses SASL/PLAIN only when both credentials are configured', () => {
    expect(
      billingKafkaConfig({
        KAFKA_BROKERS: 'kafka:9092',
        KAFKA_SASL_USERNAME: 'user',
        KAFKA_SASL_PASSWORD: 'pass',
      })
    ).toEqual({
      clientId: 'billing-service',
      brokers: ['kafka:9092'],
      sasl: { mechanism: 'plain', username: 'user', password: 'pass' },
    });
    expect(billingKafkaConfig({ KAFKA_BROKERS: 'kafka:9092' }).brokers).toEqual(['kafka:9092']);
    expect(() =>
      billingKafkaConfig({ KAFKA_BROKERS: 'kafka:9092', KAFKA_SASL_USERNAME: 'user' })
    ).toThrow('devem ser configurados juntos');
    expect(BILLING_TOPIC).toBe('billing.eventos.v1');
    expect(BILLING_PRODUCER_OPTIONS).toEqual({ idempotent: true, allowAutoTopicCreation: false });
  });

  it('wraps domain events with the agreed envelope and order-service correlation', () => {
    const envelope = billingEventEnvelope(
      new OrcamentoGerado('os-1', 'orc-1'),
      '123e4567-e89b-12d3-a456-426614174000'
    );
    expect(envelope).toMatchObject({
      eventId: '123e4567-e89b-12d3-a456-426614174000',
      eventType: 'OrcamentoGerado',
      eventVersion: 1,
      correlationId: 'os-1',
      producer: 'billing-service',
      data: { ordemServicoId: 'os-1', orcamentoId: 'orc-1' },
    });
    expect(new Date(envelope.occurredAt).toISOString()).toBe(envelope.occurredAt);
    expect(billingKafkaSendRequest(BILLING_TOPIC, 'os-1', envelope)).toEqual({
      topic: BILLING_TOPIC,
      acks: -1,
      messages: [{ key: 'os-1', value: JSON.stringify(envelope) }],
    });
  });
});
