import { Controller, NotImplementedException, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../../auth/decorators/public.decorator';

// Publica: o Mercado Pago nao apresenta nosso JWT; a assinatura x-signature entra na Feature #325.
@ApiTags('Webhooks')
@Controller('webhooks/mercado-pago')
export class MercadoPagoWebhookController {
  @Public()
  @Post()
  @ApiOperation({
    summary: 'Receber notificacao do Mercado Pago (publica, autenticada por assinatura)',
  })
  @ApiResponse({ status: 501, description: 'Ainda nao implementado (Feature #325)' })
  receber(): never {
    throw new NotImplementedException('Webhook do Mercado Pago entra na Feature #325');
  }
}
