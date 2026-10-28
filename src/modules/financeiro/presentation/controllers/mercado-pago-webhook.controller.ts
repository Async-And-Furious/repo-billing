import { Controller, HttpCode, HttpStatus, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  @ApiResponse({
    status: 200,
    description: 'Notificação recebida (inclusive reentrega ou ignorada).',
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
    if (tipo !== 'payment' || !dataId) {
      this.logger.log(`Notificação do Mercado Pago ignorada: type=${tipo ?? '-'}`);
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
