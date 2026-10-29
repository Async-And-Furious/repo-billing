import { Orcamento, StatusOrcamento } from '../../domain/entities/orcamento.entity';
import { OrcamentoGerado } from '../../domain/events/orcamento.events';
import type {
  IOrcamentoRepository,
  IPublicadorEventos,
} from '../../domain/interfaces/financeiro.interfaces';
import { GerarOrcamentoHandler } from './gerar-orcamento.handler';

describe('GerarOrcamentoHandler', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const evento = {
    ordemServicoId,
    valorTotalServicos: 450,
    valorTotalPecas: 320.5,
    valorTotalGeral: 770.5,
  };

  let repository: jest.Mocked<IOrcamentoRepository>;
  let publicador: jest.Mocked<IPublicadorEventos>;
  let handler: GerarOrcamentoHandler;

  const existente = (status: StatusOrcamento) =>
    Orcamento.reconstituir({
      id: 'orc-1',
      ordemServicoId,
      valorTotalServicos: 10,
      valorTotalPecas: 20,
      valorTotalGeral: 30,
      status,
    });

  beforeEach(() => {
    repository = {
      findByOrdemServicoId: jest.fn().mockResolvedValue(null),
      criar: jest.fn().mockResolvedValue(undefined),
      atualizarTotaisSePendente: jest.fn().mockResolvedValue(true),
      aprovarComPagamento: jest.fn(),
      desfazerAprovacao: jest.fn(),
      recusarSePendente: jest.fn(),
    };
    publicador = { publicar: jest.fn().mockResolvedValue(undefined) };
    handler = new GerarOrcamentoHandler(repository, publicador);
  });

  it('depende só do repositório de orçamento e do publicador (sem catálogo nem itens da OS)', () => {
    // Nenhuma porta para Peca, Servico, OsPeca ou OsServico: os totais vêm só do evento.
    expect(GerarOrcamentoHandler.length).toBe(2);
  });

  it('cria o orçamento PENDING com os três totais do evento e publica OrcamentoGerado', async () => {
    await expect(handler.handle(evento)).resolves.toBe('GERADO');

    const criado = repository.criar.mock.calls[0][0];
    expect(criado.getStatus()).toBe(StatusOrcamento.PENDING);
    expect(criado.getValorTotalServicos()).toBe(450);
    expect(criado.getValorTotalPecas()).toBe(320.5);
    expect(criado.getValorTotalGeral()).toBe(770.5);
    expect(publicador.publicar).toHaveBeenCalledWith(
      new OrcamentoGerado(ordemServicoId, criado.getId())
    );
  });

  it('persiste o total geral recebido mesmo que não bata com a soma (não recalcula)', async () => {
    await handler.handle({ ...evento, valorTotalGeral: 800 });
    expect(repository.criar.mock.calls[0][0].getValorTotalGeral()).toBe(800);
  });

  it('atualiza os totais de orçamento ainda pendente', async () => {
    repository.findByOrdemServicoId.mockResolvedValue(existente(StatusOrcamento.PENDING));

    await expect(handler.handle(evento)).resolves.toBe('ATUALIZADO');

    const atualizado = repository.atualizarTotaisSePendente.mock.calls[0][0];
    expect(atualizado.getValorTotalGeral()).toBe(770.5);
    expect(repository.criar).not.toHaveBeenCalled();
    expect(publicador.publicar).toHaveBeenCalledWith(new OrcamentoGerado(ordemServicoId, 'orc-1'));
  });

  it.each([StatusOrcamento.APPROVED, StatusOrcamento.REJECTED])(
    'ignora o evento repetido com o orçamento %s, sem erro',
    async (status) => {
      repository.findByOrdemServicoId.mockResolvedValue(existente(status));

      await expect(handler.handle(evento)).resolves.toBe('IGNORADO');
      expect(repository.atualizarTotaisSePendente).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    }
  );

  it('ignora quando a aprovação chega entre a leitura e a gravação dos totais', async () => {
    repository.findByOrdemServicoId.mockResolvedValue(existente(StatusOrcamento.PENDING));
    repository.atualizarTotaisSePendente.mockResolvedValue(false);

    await expect(handler.handle(evento)).resolves.toBe('IGNORADO');
    expect(publicador.publicar).not.toHaveBeenCalled();
  });
});
