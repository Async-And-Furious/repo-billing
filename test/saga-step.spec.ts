// #326: o agente do New Relic implementa recordCustomEvent como método que lê `this.agent`.
// O mock reproduz isso: uma chamada sem o objeto do agente como `this` lança TypeError.
const registrados: Array<[string, Record<string, unknown>]> = [];
const agente = {
  agent: {},
  recordCustomEvent(
    this: { agent?: object } | undefined,
    tipo: string,
    atributos: Record<string, unknown>
  ) {
    if (!this?.agent) throw new TypeError("Cannot read properties of undefined (reading 'agent')");
    registrados.push([tipo, atributos]);
  },
};

jest.mock('newrelic', () => ({ __esModule: true, default: agente, ...agente }));

import { Logger } from '@nestjs/common';
import { recordSagaStep } from '../src/shared/infrastructure/observability/saga-step';

describe('recordSagaStep', () => {
  beforeEach(() => {
    registrados.length = 0;
  });

  it('registra o SagaStep pelo objeto do agente, sem perder o this', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    recordSagaStep('os-1', 'orcamento', 'SUCCESS', Date.now() - 5);

    expect(warn).not.toHaveBeenCalled();
    expect(registrados).toHaveLength(1);
    expect(registrados[0][0]).toBe('SagaStep');
    expect(registrados[0][1]).toMatchObject({
      ordemServicoId: 'os-1',
      service: 'billing',
      step: 'orcamento',
      outcome: 'SUCCESS',
    });
    warn.mockRestore();
  });
});
