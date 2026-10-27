import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import type { Orcamento } from '../../domain/entities/orcamento.entity';
import type { IOrcamentoRepository } from '../../domain/interfaces/financeiro.interfaces';

export class ConsultarOrcamentoUseCase {
  constructor(private readonly orcamentoRepository: IOrcamentoRepository) {}

  async execute(ordemServicoId: string): Promise<Orcamento> {
    const orcamento = await this.orcamentoRepository.findByOrdemServicoId(ordemServicoId);
    if (!orcamento) {
      throw new EntityNotFoundException('Orcamento', ordemServicoId);
    }
    return orcamento;
  }
}
