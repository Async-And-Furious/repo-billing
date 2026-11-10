import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import { AuthModule } from './auth/auth.module';
import { FinanceiroModule } from './modules/financeiro/financeiro.module';
import { KafkaConsumidorModule } from './modules/financeiro/infrastructure/messaging/kafka-consumidor.module';
import { HealthModule } from './modules/health/health.module';
import { RolesGuard } from './auth/guards/roles.guard';
import { JwtAndThrottlingGuard } from './shared/infrastructure/throttling/jwt-and-throttling.guard';
import { AuthenticatedThrottlerGuard } from './shared/infrastructure/throttling/authenticated-throttler.guard';
import { GlobalExceptionFilter } from './shared/infrastructure/filters/global-exception.filter';
import { THROTTLER_GLOBAL } from './shared/infrastructure/throttling/throttler.config';
import { pinoHttpOptions } from './shared/infrastructure/logging/pino-logger.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({ pinoHttp: pinoHttpOptions }),
    ThrottlerModule.forRoot([{ name: THROTTLER_GLOBAL, ttl: 60000, limit: 100 }]),
    DatabaseModule,
    AuthModule,
    FinanceiroModule,
    KafkaConsumidorModule,
    HealthModule,
  ],
  providers: [
    AuthenticatedThrottlerGuard,
    JwtAndThrottlingGuard,
    { provide: APP_GUARD, useExisting: JwtAndThrottlingGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
