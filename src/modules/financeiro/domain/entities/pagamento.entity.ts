import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';

// Mesmos valores do enum StatusPagamento do schema.
export enum StatusPagamento {
  AGUARDANDO_PAGAMENTO = 'AGUARDANDO_PAGAMENTO',
  CONFIRMADO = 'CONFIRMADO',
  RECUSADO = 'RECUSADO',
  CANCELADO = 'CANCELADO',
  ESTORNADO = 'ESTORNADO',
}

export interface Cobranca {
  preferenceId: string;
  linkPagamento: string;
}

interface PagamentoProps {
  id: string;
  ordemServicoId: string;
  valor: number;
  status: StatusPagamento;
  preferenceId: string | null;
  linkPagamento: string | null;
  // Id do pagamento no Mercado Pago, gravado quando o webhook o confirma ou recusa (único).
  pagamentoExternoId: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

// AGUARDANDO_PAGAMENTO → CONFIRMADO | RECUSADO | CANCELADO; CONFIRMADO → ESTORNADO.
// CANCELADO e ESTORNADO são os estados da compensação da saga; o estorno não gera evento.
export class Pagamento {
  private constructor(private props: PagamentoProps) {}

  // Nasce na aprovação do orçamento, já com a preference do Mercado Pago criada.
  static criar(ordemServicoId: string, valor: number, cobranca: Cobranca): Pagamento {
    if (!(valor > 0)) {
      throw new DomainException('Valor do pagamento deve ser positivo.');
    }
    const agora = new Date();
    return new Pagamento({
      id: crypto.randomUUID(),
      ordemServicoId,
      valor,
      status: StatusPagamento.AGUARDANDO_PAGAMENTO,
      preferenceId: cobranca.preferenceId,
      linkPagamento: cobranca.linkPagamento,
      pagamentoExternoId: null,
      criadoEm: agora,
      atualizadoEm: agora,
    });
  }

  static reconstituir(props: PagamentoProps): Pagamento {
    return new Pagamento({ ...props });
  }

  confirmar(pagamentoExternoId: string): void {
    this.transicionar(StatusPagamento.AGUARDANDO_PAGAMENTO, StatusPagamento.CONFIRMADO);
    this.props.pagamentoExternoId = pagamentoExternoId;
  }

  recusar(pagamentoExternoId: string): void {
    this.transicionar(StatusPagamento.AGUARDANDO_PAGAMENTO, StatusPagamento.RECUSADO);
    this.props.pagamentoExternoId = pagamentoExternoId;
  }

  // Saga falhou antes do pagamento.
  cancelar(): void {
    this.transicionar(StatusPagamento.AGUARDANDO_PAGAMENTO, StatusPagamento.CANCELADO);
  }

  // Refund de um pagamento já confirmado.
  estornar(): void {
    this.transicionar(StatusPagamento.CONFIRMADO, StatusPagamento.ESTORNADO);
  }

  estaPendente(): boolean {
    return this.props.status === StatusPagamento.AGUARDANDO_PAGAMENTO;
  }

  getId(): string {
    return this.props.id;
  }
  getOrdemServicoId(): string {
    return this.props.ordemServicoId;
  }
  getValor(): number {
    return this.props.valor;
  }
  getStatus(): StatusPagamento {
    return this.props.status;
  }
  getPreferenceId(): string | null {
    return this.props.preferenceId;
  }
  getLinkPagamento(): string | null {
    return this.props.linkPagamento;
  }
  getPagamentoExternoId(): string | null {
    return this.props.pagamentoExternoId;
  }
  getCriadoEm(): Date {
    return this.props.criadoEm;
  }
  getAtualizadoEm(): Date {
    return this.props.atualizadoEm;
  }

  private transicionar(de: StatusPagamento, para: StatusPagamento): void {
    if (this.props.status !== de) {
      throw new DomainException(`Pagamento não pode passar de ${this.props.status} para ${para}.`);
    }
    this.props.status = para;
  }
}
