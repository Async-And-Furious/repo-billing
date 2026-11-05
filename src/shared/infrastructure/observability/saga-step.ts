import { Logger } from '@nestjs/common';
import { recordCustomEvent } from 'newrelic';

export type SagaStepOutcome = 'SUCCESS' | 'FAILED';

const logger = new Logger('SagaStep');

/** Phase 4 APM convention: one `SagaStep` custom event per saga step. Telemetry never breaks processing. */
export const recordSagaStep = (
  ordemServicoId: string,
  step: string,
  outcome: SagaStepOutcome,
  startedAt: number
): void => {
  try {
    recordCustomEvent('SagaStep', {
      ordemServicoId,
      service: 'billing',
      step,
      outcome,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.warn({ ordemServicoId, step, error: String(error) }, 'Falha ao registrar SagaStep');
  }
};
