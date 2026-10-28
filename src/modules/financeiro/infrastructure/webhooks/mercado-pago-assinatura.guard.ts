import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvalidWebhookSignatureError, WebhookSignatureValidator } from 'mercadopago';
import type { Request } from 'express';

// Valida o x-signature (HMAC-SHA256) com o validador oficial do SDK, antes de qualquer efeito.
// O data.id vem da query string, como define a documentação do Mercado Pago.
// Só a notificação de pagamento (type=payment com data.id) altera estado; as demais
// (ex.: IPN legado ?id=&topic=, que não traz data.id e nunca valida) passam sem assinatura
// e o controller as ignora com 200, para o Mercado Pago não ficar reenviando.
@Injectable()
export class MercadoPagoAssinaturaGuard implements CanActivate {
  private readonly logger = new Logger(MercadoPagoAssinaturaGuard.name);
  // Aviso de configuração ausente sai uma vez por processo, não a cada notificação recebida.
  private avisouSemSegredo = false;

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.query['type'] !== 'payment' || !request.query['data.id']) {
      return true;
    }

    // data.id repetido na query: o validador usaria só o primeiro, e o controller receberia um array.
    if (Array.isArray(request.query['data.id'])) {
      this.logger.warn('Notificação do Mercado Pago com data.id repetido recusada.');
      throw new UnauthorizedException('Webhook não autorizado');
    }

    const secret = this.config.get<string>('MP_WEBHOOK_SECRET');
    if (!secret) {
      if (!this.avisouSemSegredo) {
        this.avisouSemSegredo = true;
        this.logger.warn(
          'MP_WEBHOOK_SECRET não configurado: notificações do Mercado Pago serão recusadas com 401.'
        );
      }
      throw new UnauthorizedException('Webhook não autorizado');
    }

    try {
      WebhookSignatureValidator.validate({
        xSignature: request.header('x-signature'),
        xRequestId: request.header('x-request-id'),
        dataId: request.query['data.id'] as string,
        secret,
      });
      return true;
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        this.logger.warn(
          `Assinatura do Mercado Pago inválida (${error.reason}), x-request-id=${error.requestId ?? '-'}`
        );
        throw new UnauthorizedException('Webhook não autorizado');
      }
      throw error;
    }
  }
}
