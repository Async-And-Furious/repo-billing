import { CompensarFalhaSagaHandler } from '../src/modules/financeiro/application/event-handlers/compensar-falha-saga.handler';
import {
  Pagamento,
  StatusPagamento,
} from '../src/modules/financeiro/domain/entities/pagamento.entity';
import type {
  IGatewayPagamento,
  IPagamentoRepository,
} from '../src/modules/financeiro/domain/interfaces/financeiro.interfaces';
import { PagamentoRepository } from '../src/modules/financeiro/infrastructure/repositories/pagamento.repository';
import type { IOrcamentoRepository } from '../src/modules/financeiro/domain/interfaces/financeiro.interfaces';

describe('CompensarFalhaSagaHandler', () => {
  const payment = (status: StatusPagamento, externalId: string | null = 'mp-1') =>
    Pagamento.reconstituir({
      id: 'payment-1',
      ordemServicoId: 'os-1',
      valor: 100,
      status,
      preferenceId: 'preference-1',
      linkPagamento: 'https://example.test/pay',
      pagamentoExternoId: externalId,
      criadoEm: new Date(),
      atualizadoEm: new Date(),
    });

  const setup = (pagamento: Pagamento | null) => {
    const orcamentoRepository = {
      encerrarSeAberto: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<IOrcamentoRepository>;
    const repository: jest.Mocked<IPagamentoRepository> = {
      findByOrdemServicoId: jest.fn().mockResolvedValue(pagamento),
      salvarCobranca: jest.fn(),
      cancelarSePendente: jest.fn(),
      estornarSeConfirmado: jest.fn(),
      salvarComNotificacao: jest.fn(),
      jaRecebida: jest.fn(),
      registrar: jest.fn(),
    };
    const gateway: jest.Mocked<IGatewayPagamento> = {
      criarCobranca: jest.fn(),
      consultarPagamento: jest.fn(),
      estornar: jest.fn().mockResolvedValue(undefined),
    };
    return {
      repository,
      gateway,
      orcamentoRepository,
      handler: new CompensarFalhaSagaHandler(repository, gateway, orcamentoRepository),
    };
  };

  it('closes pending budget when saga failure arrives before payment exists', async () => {
    const { handler, repository, gateway, orcamentoRepository } = setup(null);
    await handler.execute({ ordemServicoId: 'os-1', etapa: 'orcamento' });
    expect(orcamentoRepository.encerrarSeAberto).not.toHaveBeenCalled();
    await handler.execute({ ordemServicoId: 'os-1', etapa: 'inicio-execucao' });
    expect(repository.findByOrdemServicoId).toHaveBeenCalledTimes(1);
    expect(orcamentoRepository.encerrarSeAberto).toHaveBeenCalledWith('os-1');
    expect(gateway.estornar).not.toHaveBeenCalled();
  });

  it('checks payment after closing an in-flight approval and refunds a confirmed winner', async () => {
    const { handler, repository, gateway, orcamentoRepository } = setup(null);
    repository.findByOrdemServicoId.mockResolvedValue(payment(StatusPagamento.CONFIRMADO));
    repository.estornarSeConfirmado.mockResolvedValue(true);

    await handler.execute({ ordemServicoId: 'os-1', etapa: 'aprovacao-pagamento' });

    expect(orcamentoRepository.encerrarSeAberto).toHaveBeenCalledWith('os-1');
    expect(repository.findByOrdemServicoId).toHaveBeenCalledTimes(1);
    expect(gateway.estornar).toHaveBeenCalledWith('mp-1');
  });

  it('cancels pending payments without calling Mercado Pago', async () => {
    const { handler, repository, gateway } = setup(payment(StatusPagamento.AGUARDANDO_PAGAMENTO));
    repository.cancelarSePendente.mockResolvedValue(true);
    await handler.execute({ ordemServicoId: 'os-1', etapa: 'aprovacao-pagamento' });
    expect(repository.cancelarSePendente).toHaveBeenCalledWith('os-1');
    expect(gateway.estornar).not.toHaveBeenCalled();
  });

  it('re-reads after a pending cancellation loses a race to webhook confirmation', async () => {
    const { handler, repository, gateway } = setup(payment(StatusPagamento.AGUARDANDO_PAGAMENTO));
    repository.cancelarSePendente.mockResolvedValue(false);
    repository.findByOrdemServicoId.mockResolvedValueOnce(
      payment(StatusPagamento.AGUARDANDO_PAGAMENTO)
    );
    repository.findByOrdemServicoId.mockResolvedValueOnce(payment(StatusPagamento.CONFIRMADO));
    repository.estornarSeConfirmado.mockResolvedValue(true);
    await handler.execute({ ordemServicoId: 'os-1', etapa: 'aprovacao-pagamento' });
    expect(repository.findByOrdemServicoId).toHaveBeenCalledTimes(2);
    expect(gateway.estornar).toHaveBeenCalledWith('mp-1');
    expect(repository.estornarSeConfirmado).toHaveBeenCalledWith('os-1');
  });

  it('refunds confirmed payment before marking it estornado', async () => {
    const { handler, repository, gateway } = setup(payment(StatusPagamento.CONFIRMADO));
    const order: string[] = [];
    gateway.estornar.mockImplementation(() => {
      order.push('refund');
      return Promise.resolve();
    });
    repository.estornarSeConfirmado.mockImplementation(() => {
      order.push('save');
      return Promise.resolve(true);
    });
    await handler.execute({ ordemServicoId: 'os-1', etapa: 'inicio-execucao' });
    expect(order).toEqual(['refund', 'save']);
    expect(gateway.estornar).toHaveBeenCalledWith('mp-1');
  });

  it('retries the same idempotent refund when database finalization fails', async () => {
    const { handler, repository, gateway } = setup(payment(StatusPagamento.CONFIRMADO));
    repository.estornarSeConfirmado
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(true);
    const evento = { ordemServicoId: 'os-1', etapa: 'inicio-execucao' };
    await expect(handler.execute(evento)).rejects.toThrow('database unavailable');
    await handler.execute(evento);
    expect(gateway.estornar).toHaveBeenNthCalledWith(1, 'mp-1');
    expect(gateway.estornar).toHaveBeenNthCalledWith(2, 'mp-1');
  });

  it('does not refund again when the payment is already estornado', async () => {
    const { handler, repository, gateway } = setup(payment(StatusPagamento.ESTORNADO));
    await handler.execute({ ordemServicoId: 'os-1', etapa: 'inicio-execucao' });
    expect(gateway.estornar).not.toHaveBeenCalled();
    expect(repository.estornarSeConfirmado).not.toHaveBeenCalled();
  });

  it('uses the same provider id for concurrent duplicate compensation', async () => {
    const { handler, repository, gateway } = setup(payment(StatusPagamento.CONFIRMADO));
    repository.findByOrdemServicoId
      .mockResolvedValueOnce(payment(StatusPagamento.CONFIRMADO))
      .mockResolvedValueOnce(payment(StatusPagamento.CONFIRMADO))
      .mockResolvedValueOnce(payment(StatusPagamento.ESTORNADO));
    let finalizado = false;
    repository.estornarSeConfirmado.mockImplementation(() => {
      if (finalizado) return Promise.resolve(false);
      finalizado = true;
      return Promise.resolve(true);
    });

    await Promise.all([
      handler.execute({ ordemServicoId: 'os-1', etapa: 'inicio-execucao' }),
      handler.execute({ ordemServicoId: 'os-1', etapa: 'inicio-execucao' }),
    ]);

    expect(gateway.estornar).toHaveBeenCalledTimes(2);
    expect(gateway.estornar).toHaveBeenNthCalledWith(1, 'mp-1');
    expect(gateway.estornar).toHaveBeenNthCalledWith(2, 'mp-1');
  });

  it('does not silently acknowledge a confirmed payment without its external id', async () => {
    const { handler, gateway } = setup(payment(StatusPagamento.CONFIRMADO, null));
    await expect(
      handler.execute({ ordemServicoId: 'os-1', etapa: 'inicio-execucao' })
    ).rejects.toThrow('sem id externo');
    expect(gateway.estornar).not.toHaveBeenCalled();
  });
});

describe('PagamentoRepository compensation transitions', () => {
  it('uses short conditional status updates without opening a transaction', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { pagamento: { updateMany } };
    const repository = new PagamentoRepository(prisma as never);

    expect(await repository.cancelarSePendente('os-1')).toBe(true);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { ordemServicoId: 'os-1', status: StatusPagamento.AGUARDANDO_PAGAMENTO },
      data: { status: StatusPagamento.CANCELADO },
    });
    expect(await repository.estornarSeConfirmado('os-1')).toBe(true);
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { ordemServicoId: 'os-1', status: StatusPagamento.CONFIRMADO },
      data: { status: StatusPagamento.ESTORNADO },
    });
  });
});
