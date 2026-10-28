import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import { Pagamento, StatusPagamento } from '../../domain/entities/pagamento.entity';
import type { IPagamentoRepository } from '../../domain/interfaces/financeiro.interfaces';
import { ConsultarPagamentoUseCase } from './consultar-pagamento.use-case';

describe('ConsultarPagamentoUseCase', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  let repository: jest.Mocked<IPagamentoRepository>;
  let useCase: ConsultarPagamentoUseCase;

  beforeEach(() => {
    repository = {
      findByOrdemServicoId: jest.fn(),
      salvarComNotificacao: jest.fn(),
      jaRecebida: jest.fn(),
      registrar: jest.fn(),
    };
    useCase = new ConsultarPagamentoUseCase(repository);
  });

  it('devolve o pagamento da OS', async () => {
    const pagamento = Pagamento.reconstituir({
      id: 'pag-1',
      ordemServicoId,
      valor: 770.5,
      status: StatusPagamento.CONFIRMADO,
      preferenceId: 'pref-1',
      linkPagamento: 'https://mp/pref-1',
      pagamentoExternoId: 'mp-1',
      criadoEm: new Date('2026-10-27T10:00:00Z'),
      atualizadoEm: new Date('2026-10-27T11:00:00Z'),
    });
    repository.findByOrdemServicoId.mockResolvedValue(pagamento);

    await expect(useCase.execute(ordemServicoId)).resolves.toBe(pagamento);
    expect(repository.findByOrdemServicoId).toHaveBeenCalledWith(ordemServicoId);
  });

  it('lança EntityNotFoundException quando a OS não tem pagamento', async () => {
    repository.findByOrdemServicoId.mockResolvedValue(null);

    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(EntityNotFoundException);
  });
});
