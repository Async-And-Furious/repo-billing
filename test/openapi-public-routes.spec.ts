import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../src/auth/decorators/public.decorator';
import { OrcamentoController } from '../src/modules/financeiro/presentation/controllers/orcamento.controller';
import { PagamentoController } from '../src/modules/financeiro/presentation/controllers/pagamento.controller';
import { MercadoPagoWebhookController } from '../src/modules/financeiro/presentation/controllers/mercado-pago-webhook.controller';
import { HealthController } from '../src/modules/health/presentation/controllers/health.controller';

type Operation = { security?: unknown[] };
type Document = { paths: Record<string, Record<string, Operation>> };

const document = JSON.parse(
  readFileSync(join(__dirname, '../docs/openapi.json'), 'utf8')
) as Document;

const toOpenApiPath = (controller: string, route: string): string =>
  `/api/v1/${[controller, route].filter(Boolean).join('/')}`
    .replace(/\/+/g, '/')
    .replace(/:([A-Za-z]+)/g, '{$1}')
    .replace(/\/$/, '');

describe('docs/openapi.json x @Public()', () => {
  const controllers = [
    OrcamentoController,
    PagamentoController,
    MercadoPagoWebhookController,
    HealthController,
  ];

  it.each(controllers)(
    'marks %p routes as public only where @Public() is applied',
    (controller) => {
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
      const handlers = Object.getOwnPropertyNames(controller.prototype)
        .map((name) => controller.prototype[name as keyof typeof controller.prototype] as unknown)
        .filter((handler): handler is object => typeof handler === 'function')
        .filter((handler) => Reflect.hasMetadata(METHOD_METADATA, handler));
      expect(handlers.length).toBeGreaterThan(0);

      for (const handler of handlers) {
        const route = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const path = toOpenApiPath(base, route === '/' ? '' : route);
        const operation = document.paths[path]?.[method.toLowerCase()];
        expect(operation).toBeDefined();
        const isPublic = classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
        expect({
          route: `${method} ${path}`,
          documentedPublic: !operation.security?.length,
        }).toEqual({
          route: `${method} ${path}`,
          documentedPublic: isPublic,
        });
      }
    }
  );
});
