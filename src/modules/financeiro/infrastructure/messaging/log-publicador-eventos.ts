import { Injectable, Logger } from '@nestjs/common';
import type { EventoOrcamento } from '../../domain/events/orcamento.events';
import type { IPublicadorEventos } from '../../domain/interfaces/financeiro.interfaces';

// Provisório: só registra o evento em log. O produtor Kafka (billing.eventos.v1, publicado
// após o commit) substitui este adapter na Feature de eventos (#326).
@Injectable()
export class LogPublicadorEventos implements IPublicadorEventos {
  private readonly logger = new Logger(LogPublicadorEventos.name);

  publicar(evento: EventoOrcamento): Promise<void> {
    this.logger.log({ evento }, `Evento ${evento.eventType} da OS ${evento.ordemServicoId}`);
    return Promise.resolve();
  }
}
