import { Module } from '@nestjs/common';
import { OrcamentoController } from './presentation/controllers/orcamento.controller';
import { MercadoPagoWebhookController } from './presentation/controllers/mercado-pago-webhook.controller';
import { OrcamentoRepository } from './infrastructure/repositories/orcamento.repository';
import { PagamentoRepository } from './infrastructure/repositories/pagamento.repository';
import { MercadoPagoGateway } from './infrastructure/gateways/mercado-pago.gateway';
import { LogPublicadorEventos } from './infrastructure/messaging/log-publicador-eventos';
import { GerarOrcamentoHandler } from './application/event-handlers/gerar-orcamento.handler';
import { AprovarOrcamentoUseCase } from './application/use-cases/aprovar-orcamento.use-case';
import { RecusarOrcamentoUseCase } from './application/use-cases/recusar-orcamento.use-case';
import { ConsultarOrcamentoUseCase } from './application/use-cases/consultar-orcamento.use-case';
import {
  GATEWAY_PAGAMENTO,
  ORCAMENTO_REPOSITORY,
  PAGAMENTO_REPOSITORY,
  PUBLICADOR_EVENTOS,
} from './domain/interfaces/financeiro.interfaces';
import type {
  IGatewayPagamento,
  IOrcamentoRepository,
  IPagamentoRepository,
  IPublicadorEventos,
} from './domain/interfaces/financeiro.interfaces';

@Module({
  controllers: [OrcamentoController, MercadoPagoWebhookController],
  providers: [
    { provide: ORCAMENTO_REPOSITORY, useClass: OrcamentoRepository },
    { provide: PAGAMENTO_REPOSITORY, useClass: PagamentoRepository },
    { provide: GATEWAY_PAGAMENTO, useClass: MercadoPagoGateway },
    { provide: PUBLICADOR_EVENTOS, useClass: LogPublicadorEventos },
    {
      provide: GerarOrcamentoHandler,
      useFactory: (repository: IOrcamentoRepository, publicador: IPublicadorEventos) =>
        new GerarOrcamentoHandler(repository, publicador),
      inject: [ORCAMENTO_REPOSITORY, PUBLICADOR_EVENTOS],
    },
    {
      provide: AprovarOrcamentoUseCase,
      useFactory: (
        orcamentoRepository: IOrcamentoRepository,
        pagamentoRepository: IPagamentoRepository,
        gateway: IGatewayPagamento,
        publicador: IPublicadorEventos
      ) =>
        new AprovarOrcamentoUseCase(orcamentoRepository, pagamentoRepository, gateway, publicador),
      inject: [ORCAMENTO_REPOSITORY, PAGAMENTO_REPOSITORY, GATEWAY_PAGAMENTO, PUBLICADOR_EVENTOS],
    },
    {
      provide: RecusarOrcamentoUseCase,
      useFactory: (repository: IOrcamentoRepository, publicador: IPublicadorEventos) =>
        new RecusarOrcamentoUseCase(repository, publicador),
      inject: [ORCAMENTO_REPOSITORY, PUBLICADOR_EVENTOS],
    },
    {
      provide: ConsultarOrcamentoUseCase,
      useFactory: (repository: IOrcamentoRepository) => new ConsultarOrcamentoUseCase(repository),
      inject: [ORCAMENTO_REPOSITORY],
    },
  ],
  // O consumidor do Kafka (#326) chama o handler ao receber OrcamentoCalculado.
  exports: [GerarOrcamentoHandler],
})
export class FinanceiroModule {}
