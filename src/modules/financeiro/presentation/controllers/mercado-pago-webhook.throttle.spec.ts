import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { THROTTLER_GLOBAL } from '../../../../shared/infrastructure/throttling/throttler.config';
import { ProcessarNotificacaoPagamentoUseCase } from '../../application/use-cases/processar-notificacao-pagamento.use-case';
import { MercadoPagoWebhookController } from './mercado-pago-webhook.controller';

@Controller('qualquer')
class RotaComum {
  @Get()
  ok(): string {
    return 'ok';
  }
}

// Throttler real, com o mesmo nome do AppModule e limite baixo: só o webhook fica isento.
describe('Webhook do Mercado Pago e o throttling global', () => {
  const limite = 3;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ name: THROTTLER_GLOBAL, ttl: 60000, limit: limite }]),
      ],
      controllers: [MercadoPagoWebhookController, RotaComum],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: ProcessarNotificacaoPagamentoUseCase, useValue: { execute: jest.fn() } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  it('as demais rotas continuam limitadas (429 depois do limite)', async () => {
    for (let i = 0; i < limite; i++) {
      await request(server).get('/qualquer').expect(200);
    }
    await request(server).get('/qualquer').expect(429);
  });

  it('o webhook nunca recebe 429, mesmo bem acima do limite', async () => {
    for (let i = 0; i < limite * 3; i++) {
      // Sem assinatura: 401, mas nunca 429. O 401 do guard só aparece se o throttler não barrou antes.
      await request(server).post('/webhooks/mercado-pago?type=topic_merchant_order_wh').expect(401);
    }
  });
});
