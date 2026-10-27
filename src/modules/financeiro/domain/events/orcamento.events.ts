import type { TotaisOrcamento } from '../entities/orcamento.entity';

// Campo data do OrcamentoCalculado publicado pelo OS Service em os.eventos.v1 (ADR-0018).
export interface OrcamentoCalculado extends TotaisOrcamento {
  ordemServicoId: string;
}

export interface EventoOrcamento {
  readonly eventType: 'OrcamentoGerado' | 'OrcamentoAprovado' | 'OrcamentoRecusado';
  readonly ordemServicoId: string;
  readonly orcamentoId: string;
}

export class OrcamentoGerado implements EventoOrcamento {
  readonly eventType = 'OrcamentoGerado';
  constructor(
    readonly ordemServicoId: string,
    readonly orcamentoId: string
  ) {}
}

export class OrcamentoAprovado implements EventoOrcamento {
  readonly eventType = 'OrcamentoAprovado';
  constructor(
    readonly ordemServicoId: string,
    readonly orcamentoId: string,
    readonly valorTotalPecas: number
  ) {}
}

export class OrcamentoRecusado implements EventoOrcamento {
  readonly eventType = 'OrcamentoRecusado';
  constructor(
    readonly ordemServicoId: string,
    readonly orcamentoId: string
  ) {}
}
