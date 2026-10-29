import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MercadoPagoConfig,
  MPNotFoundError,
  Payment,
  PaymentRefund,
  Preference,
} from 'mercadopago';
import type { Cobranca } from '../../domain/entities/pagamento.entity';
import type {
  IGatewayPagamento,
  PagamentoExterno,
} from '../../domain/interfaces/financeiro.interfaces';

// Timeout curto + 1 retry (feito pelo SDK em 429/5xx e falha de rede) para não segurar a aprovação.
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 1;

// Prazo da preference = prazo do detector de OS parada (ADR-0018, saga-flow.md §3): 48 h por
// padrão, configurável por MP_PREFERENCE_EXPIRACAO_HORAS para casar com o detector (na demo, minutos).
const EXPIRACAO_PADRAO_HORAS = 48;
const MS_POR_HORA = 3_600_000;

const descreverErro = (error: unknown): string =>
  error instanceof Error ? error.message : JSON.stringify(error);

// Checkout Pro: um item agregado ("OS {id}", valor = valorTotalGeral), sem payer. A reconsulta do
// pagamento (webhook) e o estorno (pagamento atrasado, compensação da saga) usam o mesmo client.
@Injectable()
export class MercadoPagoGateway implements IGatewayPagamento {
  private readonly logger = new Logger(MercadoPagoGateway.name);

  constructor(private readonly config: ConfigService) {}

  async criarCobranca(ordemServicoId: string, valor: number): Promise<Cobranca> {
    let preferenceId: string | undefined;
    let linkPagamento: string | undefined;
    try {
      const result = await new Preference(this.criarClient()).create({
        body: {
          items: [
            {
              id: ordemServicoId,
              title: `OS ${ordemServicoId}`,
              quantity: 1,
              unit_price: valor,
              currency_id: 'BRL',
            },
          ],
          external_reference: ordemServicoId,
          notification_url: this.config.get<string>('MP_NOTIFICATION_URL') || undefined,
          expires: true,
          expiration_date_to: this.prazoDaPreference(),
        },
      });
      preferenceId = result.id;
      linkPagamento = result.init_point;
    } catch (error) {
      this.logger.error(
        `Falha ao criar preference no Mercado Pago para a OS ${ordemServicoId}: ${descreverErro(error)}`
      );
      throw new BadGatewayException('Não foi possível gerar o link de pagamento no Mercado Pago.');
    }

    if (!preferenceId || !linkPagamento) {
      this.logger.error(`Preference sem id/init_point para a OS ${ordemServicoId}`);
      throw new BadGatewayException('Não foi possível gerar o link de pagamento no Mercado Pago.');
    }
    return { preferenceId, linkPagamento };
  }

  async consultarPagamento(pagamentoExternoId: string): Promise<PagamentoExterno | null> {
    try {
      const pagamento = await new Payment(this.criarClient()).get({ id: pagamentoExternoId });
      return {
        id: String(pagamento.id ?? pagamentoExternoId),
        status: pagamento.status ?? '',
        referenciaExterna: pagamento.external_reference ?? null,
        valor:
          typeof pagamento.transaction_amount === 'number' ? pagamento.transaction_amount : null,
      };
    } catch (error) {
      if (error instanceof MPNotFoundError) {
        return null;
      }
      this.logger.error(
        `Falha ao consultar o pagamento ${pagamentoExternoId} no Mercado Pago: ${descreverErro(error)}`
      );
      throw new BadGatewayException('Não foi possível consultar o pagamento no Mercado Pago.');
    }
  }

  async estornar(pagamentoExternoId: string): Promise<void> {
    try {
      // Chave determinística: o Mercado Pago honra X-Idempotency-Key em /v1/payments/{id}/refunds,
      // então um reenvio do webhook depois de um estorno já feito não estorna duas vezes.
      await new PaymentRefund(this.criarClient()).total({
        payment_id: pagamentoExternoId,
        requestOptions: { idempotencyKey: `estorno-${pagamentoExternoId}` },
      });
    } catch (error) {
      this.logger.error(
        `Falha ao estornar o pagamento ${pagamentoExternoId} no Mercado Pago: ${descreverErro(error)}`
      );
      throw new BadGatewayException('Não foi possível estornar o pagamento no Mercado Pago.');
    }
  }

  // ISO-8601 com offset explícito (+00:00), como nos exemplos do Mercado Pago.
  private prazoDaPreference(): string {
    const horas = this.expiracaoEmHoras();
    return new Date(Date.now() + horas * MS_POR_HORA).toISOString().replace('Z', '+00:00');
  }

  // Valor ausente ou inválido (não numérico, zero, negativo) cai no padrão, com aviso no log.
  private expiracaoEmHoras(): number {
    const configurado = this.config.get<string>('MP_PREFERENCE_EXPIRACAO_HORAS');
    if (!configurado) {
      return EXPIRACAO_PADRAO_HORAS;
    }
    const horas = Number(configurado);
    if (!Number.isFinite(horas) || horas <= 0) {
      this.logger.warn(
        `MP_PREFERENCE_EXPIRACAO_HORAS inválida ("${configurado}"): usando ${EXPIRACAO_PADRAO_HORAS} h.`
      );
      return EXPIRACAO_PADRAO_HORAS;
    }
    return horas;
  }

  private criarClient(): MercadoPagoConfig {
    const accessToken = this.config.get<string>('MP_ACCESS_TOKEN');
    if (!accessToken) {
      throw new Error('MP_ACCESS_TOKEN não configurado.');
    }
    return new MercadoPagoConfig({
      accessToken,
      options: { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
    });
  }
}
