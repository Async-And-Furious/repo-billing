import { Logger } from '@nestjs/common';
import { OrcamentoGerado } from '../../domain/events/orcamento.events';
import { LogPublicadorEventos } from './log-publicador-eventos';

describe('LogPublicadorEventos', () => {
  it('registra o evento em log', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const evento = new OrcamentoGerado('os-1', 'orc-1');

    await new LogPublicadorEventos().publicar(evento);

    expect(log).toHaveBeenCalledWith({ evento }, 'Evento OrcamentoGerado da OS os-1');
  });
});
