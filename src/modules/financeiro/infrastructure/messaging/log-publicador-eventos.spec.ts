import { Logger } from '@nestjs/common';
import { OrcamentoGerado } from '../../domain/events/orcamento.events';
import { PagamentoConfirmado, PagamentoRecusado } from '../../domain/events/pagamento.events';
import { LogPublicadorEventos } from './log-publicador-eventos';

describe('LogPublicadorEventos', () => {
  it.each([
    [new OrcamentoGerado('os-1', 'orc-1'), 'Evento OrcamentoGerado da OS os-1'],
    [new PagamentoConfirmado('os-1', 'pag-1'), 'Evento PagamentoConfirmado da OS os-1'],
    [new PagamentoRecusado('os-1', 'pag-1'), 'Evento PagamentoRecusado da OS os-1'],
  ])('registra o evento em log', async (evento, mensagem) => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await new LogPublicadorEventos().publicar(evento);

    expect(log).toHaveBeenCalledWith({ evento }, mensagem);
  });
});
