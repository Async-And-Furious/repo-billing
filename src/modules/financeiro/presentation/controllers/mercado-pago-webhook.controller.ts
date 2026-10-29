import { Controller, HttpCode, HttpStatus, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../../../auth/decorators/public.decorator';
import {
  ProcessarNotificacaoPagamentoUseCase,
  type ResultadoNotificacao,
} from '../../application/use-cases/processar-notificacao-pagamento.use-case';
import { THROTTLER_GLOBAL } from '../../../../shared/infrastructure/throttling/throttler.config';
import { MercadoPagoAssinaturaGuard } from '../../infrastructure/webhooks/mercado-pago-assinatura.guard';

// Notificação assinada que não bate com nada nosso (pagamento 404 no Mercado Pago, ou sem cobrança
// aqui) costuma ser credencial/chave de outra conta; o estorno automático também merece atenção.
const NIVEL_AVISO: ResultadoNotificacao[] = [
  'ESTORNADO_PAGAMENTO_ATRASADO',
  'ESTORNADO_PAGAMENTO_DUPLICADO',
  'PAGAMENTO_NAO_ENCONTRADO',
  'COBRANCA_NAO_ENCONTRADA',
];

// Pública: o Mercado Pago não apresenta nosso JWT; a "autenticação" é a assinatura x-signature
// validada pelo guard antes de qualquer efeito colateral (#325, ADR-0021 item 7, ADR-0022).
@ApiTags('Webhooks')
@Controller('webhooks/mercado-pago')
export class MercadoPagoWebhookController {
  private readonly logger = new Logger(MercadoPagoWebhookController.name);

  constructor(
    private readonly processarNotificacaoPagamentoUseCase: ProcessarNotificacaoPagamentoUseCase
  ) {}

  // Isenta do throttling global (100/min/IP): as notificações vêm de poucos IPs (atrás da borda, sem
  // trust proxy, todos colapsam num só), e um 429 atrasaria ou perderia o reenvio do Mercado Pago.
  // A proteção da rota é a assinatura HMAC, validada antes de qualquer efeito.
  @SkipThrottle({ [THROTTLER_GLOBAL]: true })
  @Public()
  @UseGuards(MercadoPagoAssinaturaGuard)
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receber notificação do Mercado Pago (pública, autenticada por assinatura)',
    description:
      'Valida x-signature/x-request-id (HMAC) e reconsulta o pagamento no Mercado Pago; o status nunca vem do corpo da notificação.',
  })
  @ApiQuery({ name: 'data.id', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiHeader({
    name: 'x-signature',
    required: false,
    description:
      'Assinatura HMAC-SHA256 do Mercado Pago (`ts=...,v1=...`). Obrigatória em toda notificação; ausente ou inválida devolve 401.',
  })
  @ApiHeader({
    name: 'x-request-id',
    required: false,
    description:
      'Id da requisição enviado pelo Mercado Pago, usado no manifesto da assinatura. Obrigatório junto com x-signature.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Notificação assinada e recebida (inclusive reentrega ou ignorada, como merchant_order e type=payment sem data.id).',
  })
  @ApiResponse({ status: 401, description: 'Assinatura ausente ou inválida.' })
  @ApiResponse({
    status: 409,
    description: 'O Pagamento mudou de estado durante o processamento (o Mercado Pago reenvia).',
  })
  @ApiResponse({
    status: 502,
    description: 'Falha ao reconsultar ou estornar no Mercado Pago (o Mercado Pago reenvia).',
  })
  async receber(@Query('data.id') dataId?: string, @Query('type') tipo?: string): Promise<void> {
    // Notificação assinada que não altera estado: 200 sem efeito, para o Mercado Pago não reenviar.
    if (tipo !== 'payment' || !dataId) {
      this.logger.debug('Notificação do Mercado Pago ignorada (não é type=payment com data.id).');
      return;
    }

    // Síncrono de propósito: falha na reconsulta devolve 5xx e o Mercado Pago reenvia.
    const resultado = await this.processarNotificacaoPagamentoUseCase.execute(dataId);
    const mensagem = `Notificação do pagamento ${dataId} no Mercado Pago: ${resultado}`;
    if (resultado === 'VALOR_DIVERGENTE') {
      this.logger.error(mensagem);
    } else if (NIVEL_AVISO.includes(resultado)) {
      this.logger.warn(mensagem);
    } else {
      this.logger.log(mensagem);
    }
  }
}
