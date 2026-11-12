import { StatusPagamento } from '../../domain/entities/pagamento.entity';
import type { EtapaDaSagaFalhou } from '../../domain/events/etapa-da-saga-falhou.event';
import type {
  IGatewayPagamento,
  IOrcamentoRepository,
  IPagamentoRepository,
} from '../../domain/interfaces/financeiro.interfaces';

// Etapas em que o pagamento pode existir: cancela o pendente ou estorna o capturado.
const ETAPAS_COMPENSAVEIS = new Set(['aprovacao-pagamento', 'inicio-execucao']);
// Falha no orçamento: o OS fecha a OS, e o orçamento PENDING não pode seguir aprovável e
// cobrável. Ainda não existe pagamento, então só encerra o orçamento, sem Mercado Pago (#326).
const ETAPAS_SO_ORCAMENTO = new Set(['orcamento']);

export class CompensarFalhaSagaHandler {
  constructor(
    private readonly pagamentos: IPagamentoRepository,
    private readonly gateway: IGatewayPagamento,
    private readonly orcamentos: IOrcamentoRepository
  ) {}

  async execute(evento: Pick<EtapaDaSagaFalhou, 'ordemServicoId' | 'etapa'>): Promise<void> {
    if (ETAPAS_SO_ORCAMENTO.has(evento.etapa)) {
      await this.orcamentos.encerrarSeAberto(evento.ordemServicoId);
      return;
    }
    if (!ETAPAS_COMPENSAVEIS.has(evento.etapa)) return;

    await this.orcamentos.encerrarSeAberto(evento.ordemServicoId);
    const pagamento = await this.pagamentos.findByOrdemServicoId(evento.ordemServicoId);
    if (!pagamento) return;

    if (pagamento.getStatus() === StatusPagamento.AGUARDANDO_PAGAMENTO) {
      if (await this.pagamentos.cancelarSePendente(evento.ordemServicoId)) return;

      // A confirmação do webhook pode vencer a transição pendente → cancelado.
      const atual = await this.pagamentos.findByOrdemServicoId(evento.ordemServicoId);
      if (!atual) return;
      await this.estornarSeConfirmado(
        atual.getStatus(),
        atual.getPagamentoExternoId(),
        evento.ordemServicoId
      );
      return;
    }

    await this.estornarSeConfirmado(
      pagamento.getStatus(),
      pagamento.getPagamentoExternoId(),
      evento.ordemServicoId
    );
  }

  private async estornarSeConfirmado(
    status: StatusPagamento,
    pagamentoExternoId: string | null,
    ordemServicoId: string
  ): Promise<void> {
    if (status !== StatusPagamento.CONFIRMADO) return;
    if (!pagamentoExternoId) {
      throw new Error(`Pagamento confirmado da OS ${ordemServicoId} sem id externo.`);
    }

    // O refund fica fora de transação; retries reutilizam a chave idempotente do gateway.
    await this.gateway.estornar(pagamentoExternoId);
    if (await this.pagamentos.estornarSeConfirmado(ordemServicoId)) return;

    const atual = await this.pagamentos.findByOrdemServicoId(ordemServicoId);
    if (atual?.getStatus() === StatusPagamento.ESTORNADO) return;
    throw new Error(`Pagamento da OS ${ordemServicoId} não foi finalizado como ESTORNADO.`);
  }
}
