import { BadGatewayException, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthModule } from '../../../../auth/auth.module';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../auth/guards/roles.guard';
import { FinanceiroModule } from '../../financeiro.module';
import { GlobalExceptionFilter } from '../../../../shared/infrastructure/filters/global-exception.filter';
import { Orcamento, StatusOrcamento } from '../../domain/entities/orcamento.entity';
import { Pagamento } from '../../domain/entities/pagamento.entity';
import {
  GATEWAY_PAGAMENTO,
  ORCAMENTO_REPOSITORY,
  PAGAMENTO_REPOSITORY,
  PUBLICADOR_EVENTOS,
} from '../../domain/interfaces/financeiro.interfaces';

// Guard JWT global (#323) e rotas de orcamento (#324) pela borda HTTP, com portas falsas.
describe('Rotas do Billing', () => {
  const secret = 'test-secret';
  const jwt = new JwtService({ secret });
  const ordemServicoId = '3f0c8e9a-5b1d-4c2e-9a7f-1d2e3f4a5b6c';
  const outraOs = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
  let app: INestApplication;
  let orcamentos: Map<string, Orcamento>;
  let pagamentos: Map<string, Pagamento>;
  const gateway = { criarCobranca: jest.fn() };
  const publicador = { publicar: jest.fn().mockResolvedValue(undefined) };

  // Devolve cópias, como o Prisma: mutação em memória não persiste sem passar pelo repositório.
  const copia = (orcamento: Orcamento): Orcamento =>
    Orcamento.reconstituir({
      id: orcamento.getId(),
      ordemServicoId: orcamento.getOrdemServicoId(),
      valorTotalServicos: orcamento.getValorTotalServicos(),
      valorTotalPecas: orcamento.getValorTotalPecas(),
      valorTotalGeral: orcamento.getValorTotalGeral(),
      status: orcamento.getStatus(),
    });
  const orcamentoRepository = {
    findByOrdemServicoId: (id: string) => {
      const orcamento = orcamentos.get(id);
      return Promise.resolve(orcamento ? copia(orcamento) : null);
    },
    aprovarComPagamento: (orcamento: Orcamento, pagamento: Pagamento) => {
      orcamentos.set(orcamento.getOrdemServicoId(), orcamento);
      pagamentos.set(pagamento.getOrdemServicoId(), pagamento);
      return Promise.resolve(true);
    },
    recusarSePendente: (orcamento: Orcamento) => {
      orcamentos.set(orcamento.getOrdemServicoId(), orcamento);
      return Promise.resolve(true);
    },
  };
  const pagamentoRepository = {
    findByOrdemServicoId: (id: string) => Promise.resolve(pagamentos.get(id) ?? null),
  };
  const logger = { error: jest.fn(), warn: jest.fn() };
  let server: Parameters<typeof request>[0];

  const token = (claims: Record<string, unknown>) =>
    jwt.sign(
      { sub: 'user-1', email: 'user@example.com', ...claims },
      { issuer: 'repo-auth-serverless', audience: 'async-furious-project', expiresIn: 1800 }
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [() => ({ JWT_ALGORITHM: 'HS256', JWT_SECRET: secret })],
        }),
        AuthModule,
        FinanceiroModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(ORCAMENTO_REPOSITORY)
      .useValue(orcamentoRepository)
      .overrideProvider(PAGAMENTO_REPOSITORY)
      .useValue(pagamentoRepository)
      .overrideProvider(GATEWAY_PAGAMENTO)
      .useValue(gateway)
      .overrideProvider(PUBLICADOR_EVENTOS)
      .useValue(publicador)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new GlobalExceptionFilter(logger as never));
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    gateway.criarCobranca.mockResolvedValue({
      preferenceId: 'pref-1',
      linkPagamento: 'https://mp/pref-1',
    });
    orcamentos = new Map([
      [
        ordemServicoId,
        Orcamento.criar(ordemServicoId, {
          valorTotalServicos: 450,
          valorTotalPecas: 320.5,
          valorTotalGeral: 770.5,
        }),
      ],
    ]);
    pagamentos = new Map();
  });

  it('recusa rota protegida sem token com 401', async () => {
    await request(server).get(`/api/v1/orcamentos/${ordemServicoId}`).expect(401);
  });

  it('recusa token sem role com 403 em rota com @Roles', async () => {
    await request(server)
      .get(`/api/v1/orcamentos/${ordemServicoId}`)
      .set('Authorization', `Bearer ${token({})}`)
      .expect(403);
  });

  it('deixa staff consultar o orçamento', async () => {
    const { body } = await request(server)
      .get(`/api/v1/orcamentos/${ordemServicoId}`)
      .set('Authorization', `Bearer ${token({ role: 'RECEPCIONISTA' })}`)
      .expect(200);
    expect(body).toMatchObject({ ordemServicoId, valorTotalGeral: 770.5, status: 'PENDING' });
  });

  it('consulta de OS sem orçamento devolve 404', async () => {
    await request(server)
      .get(`/api/v1/orcamentos/${outraOs}`)
      .set('Authorization', `Bearer ${token({ role: 'ADMIN' })}`)
      .expect(404);
  });

  it('id que não é UUID devolve 400', async () => {
    await request(server).patch('/api/v1/orcamentos/123/aprovar').expect(400);
  });

  it('aprova sem token (rota pública) e devolve o link de pagamento', async () => {
    const { body } = await request(server)
      .patch(`/api/v1/orcamentos/${ordemServicoId}/aprovar`)
      .expect(200);

    expect(body).toEqual({ linkPagamento: 'https://mp/pref-1' });
    expect(orcamentos.get(ordemServicoId)?.getStatus()).toBe(StatusOrcamento.APPROVED);
    expect(publicador.publicar).toHaveBeenCalledTimes(1);
  });

  it('aprovar de novo devolve o mesmo link e não republica', async () => {
    await request(server).patch(`/api/v1/orcamentos/${ordemServicoId}/aprovar`).expect(200);
    gateway.criarCobranca.mockResolvedValue({ preferenceId: 'pref-2', linkPagamento: 'outro' });

    const { body } = await request(server)
      .patch(`/api/v1/orcamentos/${ordemServicoId}/aprovar`)
      .expect(200);

    expect(body).toEqual({ linkPagamento: 'https://mp/pref-1' });
    expect(gateway.criarCobranca).toHaveBeenCalledTimes(1);
    expect(publicador.publicar).toHaveBeenCalledTimes(1);
  });

  it('falha do Mercado Pago devolve 502 e o orçamento segue PENDING', async () => {
    gateway.criarCobranca.mockRejectedValue(new BadGatewayException('Mercado Pago fora'));

    await request(server).patch(`/api/v1/orcamentos/${ordemServicoId}/aprovar`).expect(502);
    expect(orcamentos.get(ordemServicoId)?.getStatus()).toBe(StatusOrcamento.PENDING);
  });

  it('recusa sem token (rota pública) e leva o orçamento a REJECTED', async () => {
    const { body } = await request(server)
      .patch(`/api/v1/orcamentos/${ordemServicoId}/recusar`)
      .expect(200);
    expect(body).toMatchObject({ ordemServicoId, status: 'REJECTED' });
  });

  it('aprovar depois de recusar devolve 400 (erro de domínio)', async () => {
    await request(server).patch(`/api/v1/orcamentos/${ordemServicoId}/recusar`).expect(200);

    const { body } = await request(server)
      .patch(`/api/v1/orcamentos/${ordemServicoId}/aprovar`)
      .expect(400);
    expect(body.message).toContain('Status atual: REJECTED');
    expect(gateway.criarCobranca).not.toHaveBeenCalled();
  });

  it('responde o webhook do Mercado Pago sem token (rota publica)', async () => {
    await request(server).post('/api/v1/webhooks/mercado-pago').expect(501);
  });
});
