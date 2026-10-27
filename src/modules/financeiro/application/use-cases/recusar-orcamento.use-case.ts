import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';
import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import { OrcamentoRecusado } from '../../domain/events/orcamento.events';
import type { Orcamento } from '../../domain/entities/orcamento.entity';
import type {
  IOrcamentoRepository,
  IPublicadorEventos,
} from '../../domain/interfaces/financeiro.interfaces';

export class RecusarOrcamentoUseCase {
  constructor(
    private readonly orcamentoRepository: IOrcamentoRepository,
    private readonly publicador: IPublicadorEventos
  ) {}

  async execute(ordemServicoId: string): Promise<Orcamento> {
    const orcamento = await this.orcamentoRepository.findByOrdemServicoId(ordemServicoId);
    if (!orcamento) {
      throw new EntityNotFoundException('Orcamento', ordemServicoId);
    }

    orcamento.recusar();
    if (!(await this.orcamentoRepository.recusarSePendente(orcamento))) {
      throw new DomainException('O orçamento deixou de estar pendente durante a recusa.');
    }

    await this.publicador.publicar(new OrcamentoRecusado(ordemServicoId, orcamento.getId()));
    return orcamento;
  }
}
