// Exporta o OpenAPI sem subir banco: preview instancia o grafo sem rodar onModuleInit.
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { buildSwaggerConfig } from '../src/swagger.config';

async function exportOpenApi(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  app.setGlobalPrefix('api/v1');
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
  writeFileSync('docs/openapi.json', `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
}

void exportOpenApi();
