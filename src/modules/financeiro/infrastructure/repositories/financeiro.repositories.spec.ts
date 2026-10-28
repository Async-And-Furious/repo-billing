import { EstimateStatus, Prisma, StatusPagamento as StatusPagamentoPrisma } from '@prisma/client';
import type { PrismaService } from '../../../../shared/infrastructure/database/prisma.service';
import { Orcamento, StatusOrcamento } from '../../domain/entities/orcamento.entity';
import { Pagamento, StatusPagamento } from '../../domain/entities/pagamento.entity';
import { OrcamentoRepository } from './orcamento.repository';
import { PagamentoRepository } from './pagamento.repository';

describe('Repositórios do financeiro', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const orcamentoRecord = {
    id: 'orc-1',
    ordemServicoId,
    valorTotalServicos: new Prisma.Decimal('450.00'),
    valorTotalPecas: new Prisma.Decimal('320.50'),
    valorTotalGeral: new Prisma.Decimal('770.50'),
    status: EstimateStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const pagamentoRecord = {
    id: 'pag-1',
    ordemServicoId,
    valor: new Prisma.Decimal('770.50'),
    status: StatusPagamentoPrisma.AGUARDANDO_PAGAMENTO,
    preferenceId: 'pref-1',
    linkPagamento: 'https://mp/pref-1',
    mercadoPagoPaymentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const tx = {
    orcamento: { updateMany: jest.fn() },
    pagamento: { create: jest.fn() },
  };
  const prisma = {
    orcamento: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    pagamento: { findUnique: jest.fn() },
    webhookRecebido: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const orcamentoRepository = new OrcamentoRepository(prisma as unknown as PrismaService);
  const pagamentoRepository = new PagamentoRepository(prisma as unknown as PrismaService);

  const orcamento = Orcamento.reconstituir({
    id: 'orc-1',
    ordemServicoId,
    valorTotalServicos: 450,
    valorTotalPecas: 320.5,
    valorTotalGeral: 770.5,
    status: StatusOrcamento.APPROVED,
  });
  const pagamento = Pagamento.criar(ordemServicoId, 770.5, {
    preferenceId: 'pref-1',
    linkPagamento: 'https://mp/pref-1',
  });

  const violacaoUnicidade = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: ['ordem_servico_id'] },
    });

  beforeEach(() => jest.clearAllMocks());

  describe('OrcamentoRepository', () => {
    it('busca por ordemServicoId e converte Decimal em number', async () => {
      prisma.orcamento.findUnique.mockResolvedValue(orcamentoRecord);

      const encontrado = await orcamentoRepository.findByOrdemServicoId(ordemServicoId);

      expect(prisma.orcamento.findUnique).toHaveBeenCalledWith({ where: { ordemServicoId } });
      expect(encontrado?.getValorTotalGeral()).toBe(770.5);
      expect(encontrado?.getStatus()).toBe(StatusOrcamento.PENDING);
    });

    it('devolve null quando a OS não tem orçamento', async () => {
      prisma.orcamento.findUnique.mockResolvedValue(null);
      await expect(orcamentoRepository.findByOrdemServicoId(ordemServicoId)).resolves.toBeNull();
    });

    it('cria o orçamento com os totais em Decimal', async () => {
      const novo = Orcamento.criar(ordemServicoId, {
        valorTotalServicos: 450,
        valorTotalPecas: 320.5,
        valorTotalGeral: 770.5,
      });

      await orcamentoRepository.criar(novo);

      const { data } = prisma.orcamento.create.mock.calls[0][0];
      expect(data).toMatchObject({ id: novo.getId(), ordemServicoId, status: 'PENDING' });
      expect(data.valorTotalGeral.toString()).toBe('770.5');
    });

    it('atualiza os totais só se ainda PENDING', async () => {
      prisma.orcamento.updateMany.mockResolvedValue({ count: 0 });

      await expect(orcamentoRepository.atualizarTotaisSePendente(orcamento)).resolves.toBe(false);
      expect(prisma.orcamento.updateMany.mock.calls[0][0].where).toEqual({
        id: 'orc-1',
        status: EstimateStatus.PENDING,
      });
    });

    it('recusa só se ainda PENDING', async () => {
      prisma.orcamento.updateMany.mockResolvedValue({ count: 1 });

      await expect(orcamentoRepository.recusarSePendente(orcamento)).resolves.toBe(true);
      expect(prisma.orcamento.updateMany).toHaveBeenCalledWith({
        where: { id: 'orc-1', status: EstimateStatus.PENDING },
        data: { status: EstimateStatus.REJECTED },
      });
    });

    it('aprova e insere o pagamento na mesma transação', async () => {
      tx.orcamento.updateMany.mockResolvedValue({ count: 1 });

      await expect(orcamentoRepository.aprovarComPagamento(orcamento, pagamento)).resolves.toBe(
        true
      );
      expect(tx.orcamento.updateMany).toHaveBeenCalledWith({
        where: { id: 'orc-1', status: EstimateStatus.PENDING },
        data: { status: EstimateStatus.APPROVED },
      });
      expect(tx.pagamento.create.mock.calls[0][0].data).toMatchObject({
        ordemServicoId,
        status: 'AGUARDANDO_PAGAMENTO',
        preferenceId: 'pref-1',
        linkPagamento: 'https://mp/pref-1',
      });
    });

    it('não insere pagamento se o orçamento já não estava PENDING', async () => {
      tx.orcamento.updateMany.mockResolvedValue({ count: 0 });

      await expect(orcamentoRepository.aprovarComPagamento(orcamento, pagamento)).resolves.toBe(
        false
      );
      expect(tx.pagamento.create).not.toHaveBeenCalled();
    });

    it('2º pagamento da mesma OS viola a constraint única: transação desfeita, devolve false', async () => {
      tx.orcamento.updateMany.mockResolvedValue({ count: 1 });
      tx.pagamento.create.mockRejectedValue(violacaoUnicidade());

      await expect(orcamentoRepository.aprovarComPagamento(orcamento, pagamento)).resolves.toBe(
        false
      );
    });

    it('propaga outros erros do banco', async () => {
      tx.orcamento.updateMany.mockRejectedValue(new Error('conexão perdida'));

      await expect(orcamentoRepository.aprovarComPagamento(orcamento, pagamento)).rejects.toThrow(
        'conexão perdida'
      );
    });
  });

  describe('PagamentoRepository', () => {
    it('busca por ordemServicoId e reconstitui o pagamento', async () => {
      prisma.pagamento.findUnique.mockResolvedValue(pagamentoRecord);

      const encontrado = await pagamentoRepository.findByOrdemServicoId(ordemServicoId);

      expect(encontrado?.getValor()).toBe(770.5);
      expect(encontrado?.getStatus()).toBe(StatusPagamento.AGUARDANDO_PAGAMENTO);
      expect(encontrado?.getLinkPagamento()).toBe('https://mp/pref-1');
      expect(encontrado?.getCriadoEm()).toBe(pagamentoRecord.createdAt);
      expect(encontrado?.getAtualizadoEm()).toBe(pagamentoRecord.updatedAt);
    });

    it('devolve null quando a OS não tem pagamento', async () => {
      prisma.pagamento.findUnique.mockResolvedValue(null);
      await expect(pagamentoRepository.findByOrdemServicoId(ordemServicoId)).resolves.toBeNull();
    });

    describe('notificações que não mudam o Pagamento (estorno de aprovado indevido)', () => {
      const recebida = { providerEventId: 'mp-1', tipo: 'payment.approved' };

      it('jaRecebida consulta pelo unique (providerEventId, tipo)', async () => {
        prisma.webhookRecebido.findUnique.mockResolvedValue({ id: 'w-1' });
        await expect(pagamentoRepository.jaRecebida(recebida)).resolves.toBe(true);
        expect(prisma.webhookRecebido.findUnique).toHaveBeenCalledWith({
          where: { providerEventId_tipo: recebida },
          select: { id: true },
        });

        prisma.webhookRecebido.findUnique.mockResolvedValue(null);
        await expect(pagamentoRepository.jaRecebida(recebida)).resolves.toBe(false);
      });

      it('registrar grava a notificação e devolve true', async () => {
        prisma.webhookRecebido.create.mockResolvedValue({});
        await expect(pagamentoRepository.registrar(recebida)).resolves.toBe(true);
        expect(prisma.webhookRecebido.create).toHaveBeenCalledWith({ data: recebida });
      });

      it('registrar a mesma notificação de novo viola o unique e devolve false', async () => {
        prisma.webhookRecebido.create.mockRejectedValue(violacaoUnicidade());
        await expect(pagamentoRepository.registrar(recebida)).resolves.toBe(false);
      });

      it('registrar propaga outros erros do banco', async () => {
        prisma.webhookRecebido.create.mockRejectedValue(new Error('conexão perdida'));
        await expect(pagamentoRepository.registrar(recebida)).rejects.toThrow('conexão perdida');
      });
    });

    describe('salvarComNotificacao (transação com webhook_recebido)', () => {
      interface Banco {
        webhooks: { providerEventId: string; tipo: string }[];
        pagamento: { status: string; mercadoPagoPaymentId: string | null };
      }
      let banco: Banco;
      let falhaNoUpdate: Error | null;

      // Banco em memória com rollback: se o callback da transação lança, o estado volta ao
      // snapshot do início, como o Prisma faz com a transação de verdade.
      const prismaEmMemoria = () => {
        const txFalso = {
          webhookRecebido: {
            create: ({ data }: { data: { providerEventId: string; tipo: string } }) => {
              if (
                banco.webhooks.some(
                  (w) => w.providerEventId === data.providerEventId && w.tipo === data.tipo
                )
              ) {
                return Promise.reject(violacaoUnicidade());
              }
              banco.webhooks.push(data);
              return Promise.resolve(data);
            },
          },
          pagamento: {
            updateMany: ({
              where,
              data,
            }: {
              where: { status: string };
              data: { status: string; mercadoPagoPaymentId: string | null };
            }) => {
              if (falhaNoUpdate) {
                return Promise.reject(falhaNoUpdate);
              }
              if (banco.pagamento.status !== where.status) {
                return Promise.resolve({ count: 0 });
              }
              banco.pagamento = { ...data };
              return Promise.resolve({ count: 1 });
            },
          },
        };
        return {
          $transaction: async (fn: (client: typeof txFalso) => Promise<unknown>) => {
            const snapshot = structuredClone(banco);
            try {
              return await fn(txFalso);
            } catch (error) {
              banco = snapshot;
              throw error;
            }
          },
        };
      };

      const confirmado = () => {
        const p = Pagamento.criar(ordemServicoId, 770.5, {
          preferenceId: 'pref-1',
          linkPagamento: 'https://mp/pref-1',
        });
        p.confirmar('mp-1');
        return p;
      };
      const notificacao = {
        providerEventId: 'mp-1',
        tipo: 'payment.approved',
        ordemServicoId,
        resultado: 'CONFIRMADO',
      };
      const repositorio = () =>
        new PagamentoRepository(prismaEmMemoria() as unknown as PrismaService);

      beforeEach(() => {
        banco = {
          webhooks: [],
          pagamento: { status: 'AGUARDANDO_PAGAMENTO', mercadoPagoPaymentId: null },
        };
        falhaNoUpdate = null;
      });

      it('grava o webhook e a transição do Pagamento juntos', async () => {
        await expect(
          repositorio().salvarComNotificacao(
            confirmado(),
            StatusPagamento.AGUARDANDO_PAGAMENTO,
            notificacao
          )
        ).resolves.toBe(true);

        expect(banco.webhooks).toEqual([notificacao]);
        expect(banco.pagamento).toEqual({ status: 'CONFIRMADO', mercadoPagoPaymentId: 'mp-1' });
      });

      it('reentrega da mesma notificação: false e nada muda', async () => {
        const repo = repositorio();
        await repo.salvarComNotificacao(
          confirmado(),
          StatusPagamento.AGUARDANDO_PAGAMENTO,
          notificacao
        );
        const depoisDaPrimeira = structuredClone(banco);

        await expect(
          repo.salvarComNotificacao(confirmado(), StatusPagamento.AGUARDANDO_PAGAMENTO, notificacao)
        ).resolves.toBe(false);
        expect(banco).toEqual(depoisDaPrimeira);
      });

      it('falha ao atualizar o Pagamento desfaz também o webhook_recebido (rollback)', async () => {
        falhaNoUpdate = new Error('conexão perdida');

        await expect(
          repositorio().salvarComNotificacao(
            confirmado(),
            StatusPagamento.AGUARDANDO_PAGAMENTO,
            notificacao
          )
        ).rejects.toThrow('conexão perdida');

        expect(banco.webhooks).toEqual([]);
        expect(banco.pagamento).toEqual({
          status: 'AGUARDANDO_PAGAMENTO',
          mercadoPagoPaymentId: null,
        });
      });

      it('Pagamento que já mudou de status: false e o webhook também é desfeito', async () => {
        banco.pagamento.status = 'CANCELADO';

        await expect(
          repositorio().salvarComNotificacao(
            confirmado(),
            StatusPagamento.AGUARDANDO_PAGAMENTO,
            notificacao
          )
        ).resolves.toBe(false);

        expect(banco.webhooks).toEqual([]);
        expect(banco.pagamento.status).toBe('CANCELADO');
      });

      it('id externo já ligado a outro Pagamento (unique): false e webhook desfeito', async () => {
        falhaNoUpdate = violacaoUnicidade();

        await expect(
          repositorio().salvarComNotificacao(
            confirmado(),
            StatusPagamento.AGUARDANDO_PAGAMENTO,
            notificacao
          )
        ).resolves.toBe(false);
        expect(banco.webhooks).toEqual([]);
      });
    });
  });
});
