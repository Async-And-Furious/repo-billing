import { createHmac } from 'node:crypto';
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
import { Pagamento, StatusPagamento } from '../../domain/entities/pagamento.entity';
import {
  GATEWAY_PAGAMENTO,
  NotificacaoRecebida,
  ORCAMENTO_REPOSITORY,
  PAGAMENTO_REPOSITORY,
  PUBLICADOR_EVENTOS,
} from '../../domain/interfaces/financeiro.interfaces';

// Guard JWT global (#323) e rotas de orcamento (#324) pela borda HTTP, com portas falsas.
describe('Rotas do Billing', () => {
  const secret = 'test-secret';
  const chaveWebhook = 'chave-webhook-de-teste';
  const jwt = new JwtService({ secret });
  const ordemServicoId = '3f0c8e9a-5b1d-4c2e-9a7f-1d2e3f4a5b6c';
  const outraOs = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
  let app: INestApplication;
  let orcamentos: Map<string, Orcamento>;
  let pagamentos: Map<string, Pagamento>;
  const gateway = { criarCobranca: jest.fn(), consultarPagamento: jest.fn(), estornar: jest.fn() };
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
  // Como o banco: grava a transição do Pagamento e a notificação juntas; a mesma notificação
  // duas vezes viola o unique e devolve false.
  let notificacoesGravadas: Set<string>;
  const salvarComNotificacao = jest.fn(
    (pagamento: Pagamento, _statusAnterior: StatusPagamento, n: NotificacaoRecebida) => {
      const chave = `${n.providerEventId}|${n.tipo}`;
      if (notificacoesGravadas.has(chave)) {
        return Promise.resolve(false);
      }
      notificacoesGravadas.add(chave);
      pagamentos.set(pagamento.getOrdemServicoId(), pagamento);
      return Promise.resolve(true);
    }
  );
  const pagamentoRepository = {
    findByOrdemServicoId: (id: string) => Promise.resolve(pagamentos.get(id) ?? null),
    salvarComNotificacao,
    jaRecebida: (n: NotificacaoRecebida) =>
      Promise.resolve(notificacoesGravadas.has(`${n.providerEventId}|${n.tipo}`)),
    registrar: (n: NotificacaoRecebida) => {
      const chave = `${n.providerEventId}|${n.tipo}`;
      if (notificacoesGravadas.has(chave)) {
        return Promise.resolve(false);
      }
      notificacoesGravadas.add(chave);
      return Promise.resolve(true);
    },
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
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_ALGORITHM: 'HS256',
              JWT_SECRET: secret,
              MP_WEBHOOK_SECRET: chaveWebhook,
            }),
          ],
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
    notificacoesGravadas = new Set();
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

  describe('GET /pagamentos/:ordemServicoId (JWT)', () => {
    const rota = `/api/v1/pagamentos/${ordemServicoId}`;
    const pagamento = Pagamento.reconstituir({
      id: 'pag-1',
      ordemServicoId,
      valor: 770.5,
      status: StatusPagamento.CONFIRMADO,
      preferenceId: 'pref-1',
      linkPagamento: 'https://mp/pref-1',
      pagamentoExternoId: '184177738229',
      criadoEm: new Date('2026-10-27T10:00:00Z'),
      atualizadoEm: new Date('2026-10-27T11:00:00Z'),
    });

    it('sem token devolve 401', async () => {
      await request(server).get(rota).expect(401);
    });

    it('token sem role devolve 403', async () => {
      await request(server)
        .get(rota)
        .set('Authorization', `Bearer ${token({})}`)
        .expect(403);
    });

    it.each(['CLIENTE', 'MECANICO'])('papel %s devolve 403', async (role) => {
      await request(server)
        .get(rota)
        .set('Authorization', `Bearer ${token({ role })}`)
        .expect(403);
    });

    it.each(['ADMIN', 'RECEPCIONISTA'])(
      'papel %s consulta o status, o valor, o link e as datas',
      async (role) => {
        pagamentos.set(ordemServicoId, pagamento);

        const { body } = await request(server)
          .get(rota)
          .set('Authorization', `Bearer ${token({ role })}`)
          .expect(200);

        expect(body).toEqual({
          id: 'pag-1',
          ordemServicoId,
          valor: 770.5,
          status: 'CONFIRMADO',
          linkPagamento: null,
          pagamentoExternoId: '184177738229',
          criadoEm: '2026-10-27T10:00:00.000Z',
          atualizadoEm: '2026-10-27T11:00:00.000Z',
        });
      }
    );

    it('devolve o link enquanto o Pagamento aguarda pagamento', async () => {
      pagamentos.set(
        ordemServicoId,
        Pagamento.reconstituir({
          id: 'pag-1',
          ordemServicoId,
          valor: 770.5,
          status: StatusPagamento.AGUARDANDO_PAGAMENTO,
          preferenceId: 'pref-1',
          linkPagamento: 'https://mp/pref-1',
          pagamentoExternoId: null,
          criadoEm: new Date('2026-10-27T10:00:00Z'),
          atualizadoEm: new Date('2026-10-27T11:00:00Z'),
        })
      );

      const { body } = await request(server)
        .get(rota)
        .set('Authorization', `Bearer ${token({ role: 'ADMIN' })}`)
        .expect(200);

      expect(body).toMatchObject({
        status: 'AGUARDANDO_PAGAMENTO',
        linkPagamento: 'https://mp/pref-1',
        pagamentoExternoId: null,
      });
    });

    it('OS sem pagamento devolve 404', async () => {
      await request(server)
        .get(`/api/v1/pagamentos/${outraOs}`)
        .set('Authorization', `Bearer ${token({ role: 'ADMIN' })}`)
        .expect(404);
    });

    it('id que não é UUID devolve 400', async () => {
      await request(server)
        .get('/api/v1/pagamentos/123')
        .set('Authorization', `Bearer ${token({ role: 'ADMIN' })}`)
        .expect(400);
    });
  });

  describe('webhook do Mercado Pago (pública, autenticada por assinatura)', () => {
    const pagamentoExternoId = '184177738229';
    const rota = `/api/v1/webhooks/mercado-pago?data.id=${pagamentoExternoId}&type=payment`;

    const assinatura = (dataId = pagamentoExternoId, requestId = 'req-1', chave = chaveWebhook) => {
      const ts = String(Date.now());
      const v1 = createHmac('sha256', chave)
        .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
        .digest('hex');
      return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId };
    };

    const pagamentoDaOs = (status: StatusPagamento, idExterno: string | null = null) =>
      pagamentos.set(
        ordemServicoId,
        Pagamento.reconstituir({
          id: 'pag-1',
          ordemServicoId,
          valor: 770.5,
          status,
          preferenceId: 'pref-1',
          linkPagamento: 'https://mp/pref-1',
          pagamentoExternoId: idExterno,
          criadoEm: new Date('2026-10-27T10:00:00Z'),
          atualizadoEm: new Date('2026-10-27T10:00:00Z'),
        })
      );

    const reconsulta = (status: string) =>
      gateway.consultarPagamento.mockResolvedValue({
        id: pagamentoExternoId,
        status,
        referenciaExterna: ordemServicoId,
        valor: 770.5,
      });

    beforeEach(() => pagamentoDaOs(StatusPagamento.AGUARDANDO_PAGAMENTO));

    it('aceita sem token, com assinatura válida: confirma e publica PagamentoConfirmado', async () => {
      reconsulta('approved');

      await request(server).post(rota).set(assinatura()).expect(200);

      expect(salvarComNotificacao).toHaveBeenCalledTimes(1);
      expect(publicador.publicar).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PagamentoConfirmado', ordemServicoId })
      );
    });

    it('rejected recusa o pagamento e publica PagamentoRecusado', async () => {
      reconsulta('rejected');

      await request(server).post(rota).set(assinatura()).expect(200);

      expect(publicador.publicar).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PagamentoRecusado', ordemServicoId })
      );
    });

    it('pending responde 200 sem efeito algum', async () => {
      reconsulta('pending');

      await request(server).post(rota).set(assinatura()).expect(200);

      expect(salvarComNotificacao).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('assinatura ausente devolve 401 sem consultar o Mercado Pago nem mudar estado', async () => {
      await request(server).post(rota).expect(401);

      expect(gateway.consultarPagamento).not.toHaveBeenCalled();
      expect(salvarComNotificacao).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('assinatura inválida devolve 401 sem consultar o Mercado Pago nem mudar estado', async () => {
      await request(server)
        .post(rota)
        .set(assinatura(pagamentoExternoId, 'req-1', 'chave-errada'))
        .expect(401);

      expect(gateway.consultarPagamento).not.toHaveBeenCalled();
      expect(salvarComNotificacao).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('IPN legado e merchant_order respondem 200 e são ignorados', async () => {
      await request(server).post('/api/v1/webhooks/mercado-pago?id=1&topic=payment').expect(200);
      await request(server)
        .post('/api/v1/webhooks/mercado-pago?type=topic_merchant_order_wh&data.id=1')
        .expect(200);

      expect(gateway.consultarPagamento).not.toHaveBeenCalled();
      expect(salvarComNotificacao).not.toHaveBeenCalled();
    });

    it('mesma notificação entregue duas vezes: 200 nas duas e uma única atualização', async () => {
      reconsulta('approved');

      await request(server).post(rota).set(assinatura()).expect(200);
      await request(server).post(rota).set(assinatura()).expect(200);

      expect(salvarComNotificacao).toHaveBeenCalledTimes(1);
      expect(publicador.publicar).toHaveBeenCalledTimes(1);
      expect(pagamentos.get(ordemServicoId)?.getStatus()).toBe(StatusPagamento.CONFIRMADO);
    });

    it('pagamento atrasado (Pagamento CANCELADO): estorna e não publica PagamentoConfirmado', async () => {
      pagamentoDaOs(StatusPagamento.CANCELADO);
      reconsulta('approved');
      gateway.estornar.mockResolvedValue(undefined);

      await request(server).post(rota).set(assinatura()).expect(200);

      expect(gateway.estornar).toHaveBeenCalledWith(pagamentoExternoId);
      expect(publicador.publicar).not.toHaveBeenCalled();
      expect(pagamentos.get(ordemServicoId)?.getStatus()).toBe(StatusPagamento.CANCELADO);
    });

    it.each([StatusPagamento.RECUSADO, StatusPagamento.CONFIRMADO])(
      'approved com a cobrança já %s (outro id): estorna, não publica e não toca no Pagamento original',
      async (status) => {
        pagamentoDaOs(status, 'mp-original');
        reconsulta('approved');
        gateway.estornar.mockResolvedValue(undefined);

        await request(server).post(rota).set(assinatura()).expect(200);

        expect(gateway.estornar).toHaveBeenCalledWith(pagamentoExternoId);
        expect(publicador.publicar).not.toHaveBeenCalled();
        expect(salvarComNotificacao).not.toHaveBeenCalled();
        expect(pagamentos.get(ordemServicoId)?.getPagamentoExternoId()).toBe('mp-original');
        expect(pagamentos.get(ordemServicoId)?.getStatus()).toBe(status);
      }
    );

    it('reentrega de um approved estornado: 200 nas duas e um único estorno', async () => {
      pagamentoDaOs(StatusPagamento.CANCELADO);
      reconsulta('approved');
      gateway.estornar.mockResolvedValue(undefined);

      await request(server).post(rota).set(assinatura()).expect(200);
      await request(server).post(rota).set(assinatura()).expect(200);

      expect(gateway.estornar).toHaveBeenCalledTimes(1);
    });

    it('estorno falhou: 502 (o Mercado Pago reenvia) e a reentrega estorna', async () => {
      pagamentoDaOs(StatusPagamento.CANCELADO);
      reconsulta('approved');
      gateway.estornar.mockRejectedValueOnce(new BadGatewayException());
      gateway.estornar.mockResolvedValueOnce(undefined);

      await request(server).post(rota).set(assinatura()).expect(502);
      await request(server).post(rota).set(assinatura()).expect(200);

      expect(gateway.estornar).toHaveBeenCalledTimes(2);
    });

    it('falha ao reconsultar o Mercado Pago devolve 502 (o Mercado Pago reenvia)', async () => {
      gateway.consultarPagamento.mockRejectedValue(new BadGatewayException());

      await request(server).post(rota).set(assinatura()).expect(502);
      expect(salvarComNotificacao).not.toHaveBeenCalled();
    });

    it('Pagamento que muda de estado durante a gravação devolve 409 (o Mercado Pago reenvia)', async () => {
      reconsulta('approved');
      // Simula a corrida: a gravação perde porque a saga cancelou o Pagamento antes, com outro id.
      salvarComNotificacao.mockImplementationOnce(() => {
        pagamentoDaOs(StatusPagamento.CANCELADO, 'mp-de-outra-cobranca');
        return Promise.resolve(false);
      });

      await request(server).post(rota).set(assinatura()).expect(409);

      expect(publicador.publicar).not.toHaveBeenCalled();
    });
  });
});
