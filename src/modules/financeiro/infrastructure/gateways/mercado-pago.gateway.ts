import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import type { Cobranca } from '../../domain/entities/pagamento.entity';
import type { IGatewayPagamento } from '../../domain/interfaces/financeiro.interfaces';

// Timeout curto + 1 retry (feito pelo SDK em 429/5xx e falha de rede) para não segurar a aprovação.
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 1;

const descreverErro = (error: unknown): string =>
  error instanceof Error ? error.message : JSON.stringify(error);

// Checkout Pro: um item agregado ("OS {id}", valor = valorTotalGeral), sem payer.
// O webhook e a reconsulta do pagamento entram na Feature #325.
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
