import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';
import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import { Orcamento, StatusOrcamento } from '../../domain/entities/orcamento.entity';
import { OrcamentoRecusado } from '../../domain/events/orcamento.events';
import type {
  IOrcamentoRepository,
  IPublicadorEventos,
} from '../../domain/interfaces/financeiro.interfaces';
import { ConsultarOrcamentoUseCase } from './consultar-orcamento.use-case';
import { RecusarOrcamentoUseCase } from './recusar-orcamento.use-case';

describe('Recusa e consulta de orçamento', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  let repository: jest.Mocked<IOrcamentoRepository>;
  let publicador: jest.Mocked<IPublicadorEventos>;

  const orcamento = (status: StatusOrcamento) =>
    Orcamento.reconstituir({
      id: 'orc-1',
      ordemServicoId,
      valorTotalServicos: 450,
      valorTotalPecas: 320.5,
      valorTotalGeral: 770.5,
      status,
    });

  beforeEach(() => {
    repository = {
      findByOrdemServicoId: jest.fn().mockResolvedValue(orcamento(StatusOrcamento.PENDING)),
      criar: jest.fn(),
      atualizarTotaisSePendente: jest.fn(),
      aprovarComPagamento: jest.fn(),
      desfazerAprovacao: jest.fn(),
      recusarSePendente: jest.fn().mockResolvedValue(true),
    };
    publicador = { publicar: jest.fn().mockResolvedValue(undefined) };
  });

  describe('RecusarOrcamentoUseCase', () => {
    let useCase: RecusarOrcamentoUseCase;

    beforeEach(() => {
      useCase = new RecusarOrcamentoUseCase(repository, publicador);
    });

    it('leva PENDING a REJECTED e publica OrcamentoRecusado', async () => {
      const recusado = await useCase.execute(ordemServicoId);

      expect(recusado.getStatus()).toBe(StatusOrcamento.REJECTED);
      expect(repository.recusarSePendente).toHaveBeenCalledWith(recusado);
      expect(publicador.publicar).toHaveBeenCalledWith(
        new OrcamentoRecusado(ordemServicoId, 'orc-1')
      );
    });

    it('recusar orçamento já aprovado é erro de domínio', async () => {
      repository.findByOrdemServicoId.mockResolvedValue(orcamento(StatusOrcamento.APPROVED));

      await expect(useCase.execute(ordemServicoId)).rejects.toThrow(DomainException);
      expect(repository.recusarSePendente).not.toHaveBeenCalled();
    });

    it('perde a corrida para uma aprovação: erro de domínio e nada publicado', async () => {
      repository.recusarSePendente.mockResolvedValue(false);

      await expect(useCase.execute(ordemServicoId)).rejects.toThrow(DomainException);
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('orçamento inexistente vira 404', async () => {
      repository.findByOrdemServicoId.mockResolvedValue(null);
      await expect(useCase.execute(ordemServicoId)).rejects.toThrow(EntityNotFoundException);
    });
  });

  describe('ConsultarOrcamentoUseCase', () => {
    it('devolve o orçamento da OS', async () => {
      const useCase = new ConsultarOrcamentoUseCase(repository);
      const encontrado = await useCase.execute(ordemServicoId);
      expect(encontrado.getId()).toBe('orc-1');
    });

    it('orçamento inexistente vira 404', async () => {
      repository.findByOrdemServicoId.mockResolvedValue(null);
      const useCase = new ConsultarOrcamentoUseCase(repository);
      await expect(useCase.execute(ordemServicoId)).rejects.toThrow(EntityNotFoundException);
    });
  });
});
