import type { Orcamento } from '../entities/orcamento.entity';
import type { Cobranca, Pagamento, StatusPagamento } from '../entities/pagamento.entity';
import type { EventoOrcamento } from '../events/orcamento.events';
import type { EventoPagamento } from '../events/pagamento.events';

export type EventoBilling = EventoOrcamento | EventoPagamento;

// Pagamento como o Mercado Pago o reporta na reconsulta GET /v1/payments/{id}.
export interface PagamentoExterno {
  id: string;
  status: string;
  // external_reference da preference = ordemServicoId.
  referenciaExterna: string | null;
  valor: number | null;
}

// Chave de idempotência de entrada do webhook: id do pagamento no provedor + tipo (payment.{status}).
// ordemServicoId e resultado (desfecho do processamento) são gravados junto com a linha, para
// reconciliar depois o que a notificação fez.
export interface NotificacaoRecebida {
  providerEventId: string;
  tipo: string;
  ordemServicoId?: string;
  resultado?: string;
}

export interface IOrcamentoRepository {
  findByOrdemServicoId(ordemServicoId: string): Promise<Orcamento | null>;
  criar(orcamento: Orcamento): Promise<void>;
  // Grava os totais só se o orçamento continua PENDING; false se outra transição chegou antes.
  atualizarTotaisSePendente(orcamento: Orcamento): Promise<boolean>;
  // Reserva da aprovação, numa transação: Orcamento PENDING → APPROVED + insert do Pagamento (ainda sem
  // cobrança). False se o orçamento já não estava PENDING ou se a OS já tem pagamento (constraint única
  // em ordemServicoId): só uma aprovação concorrente ganha a reserva e chama o Mercado Pago.
  aprovarComPagamento(orcamento: Orcamento, pagamento: Pagamento): Promise<boolean>;
  // Compensação quando o Mercado Pago falha depois da reserva: numa transação, remove o Pagamento sem
  // cobrança e devolve o orçamento a PENDING. Nada fica gravado, como se a aprovação não tivesse ocorrido.
  desfazerAprovacao(orcamento: Orcamento, pagamento: Pagamento): Promise<void>;
  // Transição atômica PENDING → REJECTED; false se outra transição chegou antes.
  recusarSePendente(orcamento: Orcamento): Promise<boolean>;
}

export interface IPagamentoRepository {
  findByOrdemServicoId(ordemServicoId: string): Promise<Pagamento | null>;
  // Grava a cobrança (preference e link) de um Pagamento reservado. Só a aprovação que ganhou a reserva chega aqui.
  salvarCobranca(pagamento: Pagamento): Promise<void>;
  // Numa única transação: grava webhook_recebido e persiste a transição do Pagamento (status e id
  // externo), condicionada a `statusAnterior`. False, sem efeito algum, se a notificação já foi
  // vista (unique em webhook_recebido ou no id externo) ou se o Pagamento já mudou de status.
  salvarComNotificacao(
    pagamento: Pagamento,
    statusAnterior: StatusPagamento,
    notificacao: NotificacaoRecebida
  ): Promise<boolean>;
  // Notificações que não mudam o Pagamento (estorno de pagamento indevido): a idempotência é só o
  // webhook_recebido. `jaRecebida` evita estornar de novo numa reentrega; `registrar` grava a
  // notificação e devolve false se outra entrega chegou antes (unique em webhook_recebido).
  jaRecebida(notificacao: NotificacaoRecebida): Promise<boolean>;
  registrar(notificacao: NotificacaoRecebida): Promise<boolean>;
}

export interface IGatewayPagamento {
  criarCobranca(ordemServicoId: string, valor: number): Promise<Cobranca>;
  // null quando o provedor não conhece o pagamento (404); falha/timeout sobe como 502.
  consultarPagamento(pagamentoExternoId: string): Promise<PagamentoExterno | null>;
  // Estorno total, idempotente por pagamento; falha/timeout sobe como 502.
  estornar(pagamentoExternoId: string): Promise<void>;
}

export interface IPublicadorEventos {
  publicar(evento: EventoBilling): Promise<void>;
}

export const ORCAMENTO_REPOSITORY = Symbol('ORCAMENTO_REPOSITORY');
export const PAGAMENTO_REPOSITORY = Symbol('PAGAMENTO_REPOSITORY');
export const GATEWAY_PAGAMENTO = Symbol('GATEWAY_PAGAMENTO');
export const PUBLICADOR_EVENTOS = Symbol('PUBLICADOR_EVENTOS');
