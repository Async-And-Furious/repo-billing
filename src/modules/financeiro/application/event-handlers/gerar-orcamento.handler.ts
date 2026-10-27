import { Orcamento } from '../../domain/entities/orcamento.entity';
import { OrcamentoGerado } from '../../domain/events/orcamento.events';
import type { OrcamentoCalculado } from '../../domain/events/orcamento.events';
import type {
  IOrcamentoRepository,
  IPublicadorEventos,
} from '../../domain/interfaces/financeiro.interfaces';

export type ResultadoGeracao = 'GERADO' | 'ATUALIZADO' | 'IGNORADO';

// Monta o orçamento só com os totais do OrcamentoCalculado: nenhuma consulta a Peca, Servico,
// OsPeca ou OsServico, nem chamada REST ao OS Service. O consumo do Kafka entra na #326.
export class GerarOrcamentoHandler {
  constructor(
    private readonly orcamentoRepository: IOrcamentoRepository,
    private readonly publicador: IPublicadorEventos
  ) {}

  async handle(evento: OrcamentoCalculado): Promise<ResultadoGeracao> {
    const { ordemServicoId, valorTotalServicos, valorTotalPecas, valorTotalGeral } = evento;
    const totais = { valorTotalServicos, valorTotalPecas, valorTotalGeral };

    const existente = await this.orcamentoRepository.findByOrdemServicoId(ordemServicoId);
    if (!existente) {
      const orcamento = Orcamento.criar(ordemServicoId, totais);
      await this.orcamentoRepository.criar(orcamento);
      await this.publicador.publicar(new OrcamentoGerado(ordemServicoId, orcamento.getId()));
      return 'GERADO';
    }

    // Repetido depois da aprovação ou recusa: ignora sem DomainException (ADR-0018).
    if (!existente.estaPendente()) {
      return 'IGNORADO';
    }

    existente.atualizarTotais(totais);
    if (!(await this.orcamentoRepository.atualizarTotaisSePendente(existente))) {
      return 'IGNORADO';
    }
    await this.publicador.publicar(new OrcamentoGerado(ordemServicoId, existente.getId()));
    return 'ATUALIZADO';
  }
}
