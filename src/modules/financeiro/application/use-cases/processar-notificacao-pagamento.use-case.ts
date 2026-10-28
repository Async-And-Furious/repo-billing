import { ConflitoException } from '../../../../shared/domain/exceptions/conflito.exception';
import { PagamentoConfirmado, PagamentoRecusado } from '../../domain/events/pagamento.events';
import { StatusPagamento, type Pagamento } from '../../domain/entities/pagamento.entity';
import type {
  IGatewayPagamento,
  IPagamentoRepository,
  IPublicadorEventos,
  NotificacaoRecebida,
  PagamentoExterno,
} from '../../domain/interfaces/financeiro.interfaces';

export type ResultadoNotificacao =
  | 'CONFIRMADO'
  | 'RECUSADO'
  | 'ESTORNADO_PAGAMENTO_ATRASADO'
  | 'ESTORNADO_PAGAMENTO_DUPLICADO'
  | 'JA_PROCESSADO'
  | 'PAGAMENTO_NAO_ENCONTRADO'
  | 'COBRANCA_NAO_ENCONTRADA'
  | 'VALOR_DIVERGENTE'
  | 'STATUS_IGNORADO';

const STATUS_RECUSA = ['rejected', 'cancelled'];

// Compara em centavos: a diferença de um centavo nunca depende do erro de ponto flutuante.
const emCentavos = (valor: number): number => Math.round(valor * 100);

const notificacao = (externo: PagamentoExterno): NotificacaoRecebida => ({
  providerEventId: externo.id,
  tipo: `payment.${externo.status}`,
});

export class ProcessarNotificacaoPagamentoUseCase {
  constructor(
    private readonly pagamentoRepository: IPagamentoRepository,
    private readonly gateway: IGatewayPagamento,
    private readonly publicador: IPublicadorEventos
  ) {}

  // A notificação só diz "algo mudou": o status e o valor vêm sempre da reconsulta ao provedor.
  // Falha na reconsulta ou no estorno sobe como 502 e o Mercado Pago reenvia a notificação.
  async execute(pagamentoExternoId: string): Promise<ResultadoNotificacao> {
    const externo = await this.gateway.consultarPagamento(pagamentoExternoId);
    if (!externo) {
      return 'PAGAMENTO_NAO_ENCONTRADO';
    }

    const pagamento = externo.referenciaExterna
      ? await this.pagamentoRepository.findByOrdemServicoId(externo.referenciaExterna)
      : null;
    if (!pagamento) {
      return 'COBRANCA_NAO_ENCONTRADA';
    }

    if (externo.status === 'approved') {
      return this.aprovado(pagamento, externo);
    }
    if (STATUS_RECUSA.includes(externo.status)) {
      return this.recusado(pagamento, externo);
    }
    // pending, in_process, authorized etc.: sem efeito e sem evento.
    return 'STATUS_IGNORADO';
  }

  private async aprovado(
    pagamento: Pagamento,
    externo: PagamentoExterno
  ): Promise<ResultadoNotificacao> {
    // Reentrega: o id externo já foi gravado por esta mesma notificação.
    if (pagamento.getPagamentoExternoId() === externo.id) {
      return 'JA_PROCESSADO';
    }
    if (!pagamento.estaPendente()) {
      // CANCELADO (pagamento atrasado), RECUSADO, ESTORNADO ou CONFIRMADO por outro id (pagamento
      // em duplicidade): o dinheiro não é de nenhuma cobrança aberta, então é devolvido.
      return this.estornarPagamentoIndevido(pagamento, externo);
    }
    if (externo.valor === null || emCentavos(externo.valor) !== emCentavos(pagamento.getValor())) {
      return 'VALOR_DIVERGENTE';
    }

    const statusAnterior = pagamento.getStatus();
    pagamento.confirmar(externo.id);
    if (!(await this.gravar(pagamento, statusAnterior, externo))) {
      return 'JA_PROCESSADO';
    }
    await this.publicador.publicar(
      new PagamentoConfirmado(pagamento.getOrdemServicoId(), pagamento.getId())
    );
    return 'CONFIRMADO';
  }

  // Aprovado que não pode confirmar nada: não publica evento e não toca no Pagamento (nem no status
  // nem no id do pagamento original); o webhook_recebido é a idempotência e a evidência. Estorna
  // antes de gravar: se a gravação falhar, o reenvio repete o estorno com a mesma chave de
  // idempotência do Mercado Pago; se o estorno falhar (502), nada é gravado e o reenvio tenta de novo.
  private async estornarPagamentoIndevido(
    pagamento: Pagamento,
    externo: PagamentoExterno
  ): Promise<ResultadoNotificacao> {
    const recebida = notificacao(externo);
    if (await this.pagamentoRepository.jaRecebida(recebida)) {
      return 'JA_PROCESSADO';
    }

    await this.gateway.estornar(externo.id);

    if (!(await this.pagamentoRepository.registrar(recebida))) {
      return 'JA_PROCESSADO';
    }
    return pagamento.getStatus() === StatusPagamento.CANCELADO
      ? 'ESTORNADO_PAGAMENTO_ATRASADO'
      : 'ESTORNADO_PAGAMENTO_DUPLICADO';
  }

  private async recusado(
    pagamento: Pagamento,
    externo: PagamentoExterno
  ): Promise<ResultadoNotificacao> {
    if (!pagamento.estaPendente()) {
      return pagamento.getPagamentoExternoId() === externo.id ? 'JA_PROCESSADO' : 'STATUS_IGNORADO';
    }

    const statusAnterior = pagamento.getStatus();
    pagamento.recusar(externo.id);
    if (!(await this.gravar(pagamento, statusAnterior, externo))) {
      return 'JA_PROCESSADO';
    }
    await this.publicador.publicar(
      new PagamentoRecusado(pagamento.getOrdemServicoId(), pagamento.getId())
    );
    return 'RECUSADO';
  }

  // false: outra entrega da mesma notificação já gravou (reentrega, inclusive simultânea). Se o
  // Pagamento mudou de status por outro motivo no meio do caminho (ex.: a saga o cancelou), a
  // notificação não pode ser dada como processada: o erro faz o Mercado Pago reenviar, e a nova
  // leitura do Pagamento segue o ramo certo (ex.: estorno do pagamento atrasado).
  private async gravar(
    pagamento: Pagamento,
    statusAnterior: StatusPagamento,
    externo: PagamentoExterno
  ): Promise<boolean> {
    if (
      await this.pagamentoRepository.salvarComNotificacao(
        pagamento,
        statusAnterior,
        notificacao(externo)
      )
    ) {
      return true;
    }
    const atual = await this.pagamentoRepository.findByOrdemServicoId(
      pagamento.getOrdemServicoId()
    );
    if (atual?.getPagamentoExternoId() === externo.id) {
      return false;
    }
    throw new ConflitoException(
      `O Pagamento da OS ${pagamento.getOrdemServicoId()} mudou de estado enquanto a notificação ${externo.id} era processada.`
    );
  }
}
