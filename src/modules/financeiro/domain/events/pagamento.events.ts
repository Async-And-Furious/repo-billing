export interface EventoPagamento {
  readonly eventType: 'PagamentoConfirmado' | 'PagamentoRecusado';
  readonly ordemServicoId: string;
  readonly pagamentoId: string;
}

// Publicado só depois do commit da confirmação (reconsulta ao Mercado Pago com valor conferido).
export class PagamentoConfirmado implements EventoPagamento {
  readonly eventType = 'PagamentoConfirmado';
  constructor(
    readonly ordemServicoId: string,
    readonly pagamentoId: string
  ) {}
}

// Recusa terminal (rejected/cancelled no Mercado Pago); a saga fecha a OS.
export class PagamentoRecusado implements EventoPagamento {
  readonly eventType = 'PagamentoRecusado';
  constructor(
    readonly ordemServicoId: string,
    readonly pagamentoId: string
  ) {}
}
