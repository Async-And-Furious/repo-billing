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
// Toda notificação precisa de assinatura válida (#325): ausente, inválida ou sem chave configurada
// devolve 401, inclusive as que não alteram estado (IPN legado ?id=&topic=, merchant_order), que o
// Mercado Pago não assina. O data.id vem da query string, como define a documentação; quando a
// query não traz data.id, o SDK monta o manifesto sem o campo.
@Injectable()
export class MercadoPagoAssinaturaGuard implements CanActivate {
  private readonly logger = new Logger(MercadoPagoAssinaturaGuard.name);
  // Aviso de configuração ausente sai uma vez por processo, não a cada notificação recebida.
  private avisouSemSegredo = false;

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

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
        dataId: request.query['data.id'] as string | undefined,
        secret,
      });
      return true;
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        this.logger.warn(`Assinatura do Mercado Pago inválida (${error.reason})`);
        throw new UnauthorizedException('Webhook não autorizado');
      }
      throw error;
    }
  }
}
