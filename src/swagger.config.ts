import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';

export function buildSwaggerConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Async Furious - Billing Service')
    .setDescription('Orcamento e Pagamento (Fase 4)')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
}
