import { ConflitoException } from '../../../../shared/domain/exceptions/conflito.exception';
import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import { Pagamento } from '../../domain/entities/pagamento.entity';
import { OrcamentoAprovado } from '../../domain/events/orcamento.events';
import type {
  IGatewayPagamento,
  IOrcamentoRepository,
  IPagamentoRepository,
  IPublicadorEventos,
} from '../../domain/interfaces/financeiro.interfaces';

export interface AprovacaoOrcamento {
  linkPagamento: string;
}

export class AprovarOrcamentoUseCase {
  constructor(
    private readonly orcamentoRepository: IOrcamentoRepository,
    private readonly pagamentoRepository: IPagamentoRepository,
    private readonly gateway: IGatewayPagamento,
    private readonly publicador: IPublicadorEventos
  ) {}

  async execute(ordemServicoId: string): Promise<AprovacaoOrcamento> {
    const orcamento = await this.orcamentoRepository.findByOrdemServicoId(ordemServicoId);
    if (!orcamento) {
      throw new EntityNotFoundException('Orcamento', ordemServicoId);
    }

    // Aprovação repetida: mesmo link, sem republicar OrcamentoAprovado.
    if (orcamento.estaAprovado()) {
      return this.linkExistente(ordemServicoId);
    }

    // Valida antes de falar com o Mercado Pago (REJECTED ou sem valor é erro de domínio).
    orcamento.aprovar();

    // Falha do Mercado Pago sobe como 502 e nada é gravado: o orçamento segue PENDING.
    const valor = orcamento.getValorTotalGeral();
    const cobranca = await this.gateway.criarCobranca(ordemServicoId, valor);
    const pagamento = Pagamento.criar(ordemServicoId, valor, cobranca);

    if (!(await this.orcamentoRepository.aprovarComPagamento(orcamento, pagamento))) {
      // Aprovação concorrente venceu; a preference criada aqui fica sem uso e não cobra nada.
      return this.linkExistente(ordemServicoId);
    }

    await this.publicador.publicar(
      new OrcamentoAprovado(ordemServicoId, orcamento.getId(), orcamento.getValorTotalPecas())
    );
    return { linkPagamento: cobranca.linkPagamento };
  }

  private async linkExistente(ordemServicoId: string): Promise<AprovacaoOrcamento> {
    const pagamento = await this.pagamentoRepository.findByOrdemServicoId(ordemServicoId);
    const linkPagamento = pagamento?.getLinkPagamento();
    if (!linkPagamento) {
      throw new ConflitoException(
        `O orçamento da OS ${ordemServicoId} já foi aprovado, mas a cobrança não foi encontrada.`
      );
    }
    return { linkPagamento };
  }
}
