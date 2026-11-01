import { Module } from '@nestjs/common';
import { FinanceiroModule } from '../../financeiro.module';
import { KafkaConsumidorEventos } from './kafka-consumidor-eventos';

@Module({
  imports: [FinanceiroModule],
  providers: [KafkaConsumidorEventos],
})
export class KafkaConsumidorModule {}
