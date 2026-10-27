import type { Orcamento } from '../entities/orcamento.entity';
import type { Cobranca, Pagamento } from '../entities/pagamento.entity';
import type { EventoOrcamento } from '../events/orcamento.events';

export interface IOrcamentoRepository {
  findByOrdemServicoId(ordemServicoId: string): Promise<Orcamento | null>;
  criar(orcamento: Orcamento): Promise<void>;
  // Grava os totais só se o orçamento continua PENDING; false se outra transição chegou antes.
  atualizarTotaisSePendente(orcamento: Orcamento): Promise<boolean>;
  // Numa transação: Orcamento PENDING → APPROVED + insert do Pagamento. False se o orçamento
  // já não estava PENDING ou se a OS já tem pagamento (constraint única em ordemServicoId).
  aprovarComPagamento(orcamento: Orcamento, pagamento: Pagamento): Promise<boolean>;
  // Transição atômica PENDING → REJECTED; false se outra transição chegou antes.
  recusarSePendente(orcamento: Orcamento): Promise<boolean>;
}

export interface IPagamentoRepository {
  findByOrdemServicoId(ordemServicoId: string): Promise<Pagamento | null>;
}

export interface IGatewayPagamento {
  criarCobranca(ordemServicoId: string, valor: number): Promise<Cobranca>;
}

export interface IPublicadorEventos {
  publicar(evento: EventoOrcamento): Promise<void>;
}

export const ORCAMENTO_REPOSITORY = Symbol('ORCAMENTO_REPOSITORY');
export const PAGAMENTO_REPOSITORY = Symbol('PAGAMENTO_REPOSITORY');
export const GATEWAY_PAGAMENTO = Symbol('GATEWAY_PAGAMENTO');
export const PUBLICADOR_EVENTOS = Symbol('PUBLICADOR_EVENTOS');
