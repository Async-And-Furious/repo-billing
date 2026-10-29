import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import type { Pagamento } from '../../domain/entities/pagamento.entity';
import type { IPagamentoRepository } from '../../domain/interfaces/financeiro.interfaces';

export class ConsultarPagamentoUseCase {
  constructor(private readonly pagamentoRepository: IPagamentoRepository) {}

  async execute(ordemServicoId: string): Promise<Pagamento> {
    const pagamento = await this.pagamentoRepository.findByOrdemServicoId(ordemServicoId);
    if (!pagamento) {
      throw new EntityNotFoundException('Pagamento', ordemServicoId);
    }
    return pagamento;
  }
}
