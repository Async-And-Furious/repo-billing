import { ConflitoException } from '../../../../shared/domain/exceptions/conflito.exception';
import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import { Pagamento, type Cobranca } from '../../domain/entities/pagamento.entity';
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

    // Valida antes de reservar (REJECTED ou sem valor é erro de domínio).
    orcamento.aprovar();
    const valor = orcamento.getValorTotalGeral();

    // Reserva antes de falar com o Mercado Pago: o insert/update condicional tem um único vencedor,
    // e só ele cria a preference. Quem perde não chama o gateway e devolve o link (se já gravado) ou 409.
    const pagamento = Pagamento.reservar(ordemServicoId, valor);
    if (!(await this.orcamentoRepository.aprovarComPagamento(orcamento, pagamento))) {
      return this.linkExistente(ordemServicoId);
    }

    // Falha do Mercado Pago sobe como 502 e a reserva é desfeita: o orçamento volta a PENDING.
    let cobranca: Cobranca;
    try {
      cobranca = await this.gateway.criarCobranca(ordemServicoId, valor);
    } catch (error) {
      await this.orcamentoRepository.desfazerAprovacao(orcamento, pagamento);
      throw error;
    }
    pagamento.vincularCobranca(cobranca);
    await this.pagamentoRepository.salvarCobranca(pagamento);

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
        `O orçamento da OS ${ordemServicoId} já foi aprovado e o link de pagamento ainda não está disponível. Tente novamente em instantes.`
      );
    }
    return { linkPagamento };
  }
}
