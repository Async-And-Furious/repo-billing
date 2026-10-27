import { BadGatewayException } from '@nestjs/common';
import { ConflitoException } from '../../../../shared/domain/exceptions/conflito.exception';
import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';
import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import { Orcamento, StatusOrcamento } from '../../domain/entities/orcamento.entity';
import { Pagamento, StatusPagamento } from '../../domain/entities/pagamento.entity';
import { OrcamentoAprovado } from '../../domain/events/orcamento.events';
import type {
  IGatewayPagamento,
  IOrcamentoRepository,
  IPagamentoRepository,
  IPublicadorEventos,
} from '../../domain/interfaces/financeiro.interfaces';
import { AprovarOrcamentoUseCase } from './aprovar-orcamento.use-case';

describe('AprovarOrcamentoUseCase', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const cobranca = { preferenceId: 'pref-1', linkPagamento: 'https://mp/pref-1' };

  let orcamentoRepository: jest.Mocked<IOrcamentoRepository>;
  let pagamentoRepository: jest.Mocked<IPagamentoRepository>;
  let gateway: jest.Mocked<IGatewayPagamento>;
  let publicador: jest.Mocked<IPublicadorEventos>;
  let useCase: AprovarOrcamentoUseCase;

  const orcamento = (status: StatusOrcamento) =>
    Orcamento.reconstituir({
      id: 'orc-1',
      ordemServicoId,
      valorTotalServicos: 450,
      valorTotalPecas: 320.5,
      valorTotalGeral: 770.5,
      status,
    });

  const pagamentoExistente = (linkPagamento: string | null) =>
    Pagamento.reconstituir({
      id: 'pag-1',
      ordemServicoId,
      valor: 770.5,
      status: StatusPagamento.AGUARDANDO_PAGAMENTO,
      preferenceId: 'pref-antiga',
      linkPagamento,
    });

  beforeEach(() => {
    orcamentoRepository = {
      findByOrdemServicoId: jest.fn().mockResolvedValue(orcamento(StatusOrcamento.PENDING)),
      criar: jest.fn(),
      atualizarTotaisSePendente: jest.fn(),
      aprovarComPagamento: jest.fn().mockResolvedValue(true),
      recusarSePendente: jest.fn(),
    };
    pagamentoRepository = { findByOrdemServicoId: jest.fn().mockResolvedValue(null) };
    gateway = { criarCobranca: jest.fn().mockResolvedValue(cobranca) };
    publicador = { publicar: jest.fn().mockResolvedValue(undefined) };
    useCase = new AprovarOrcamentoUseCase(
      orcamentoRepository,
      pagamentoRepository,
      gateway,
      publicador
    );
  });

  it('cria a cobrança com o total geral, grava aprovação + pagamento e publica OrcamentoAprovado', async () => {
    await expect(useCase.execute(ordemServicoId)).resolves.toEqual({
      linkPagamento: 'https://mp/pref-1',
    });

    expect(gateway.criarCobranca).toHaveBeenCalledWith(ordemServicoId, 770.5);
    const [aprovado, pagamento] = orcamentoRepository.aprovarComPagamento.mock.calls[0];
    expect(aprovado.getStatus()).toBe(StatusOrcamento.APPROVED);
    expect(pagamento.getStatus()).toBe(StatusPagamento.AGUARDANDO_PAGAMENTO);
    expect(pagamento.getValor()).toBe(770.5);
    expect(pagamento.getPreferenceId()).toBe('pref-1');
    expect(publicador.publicar).toHaveBeenCalledWith(
      new OrcamentoAprovado(ordemServicoId, 'orc-1', 320.5)
    );
  });

  it('publica só depois de gravar', async () => {
    const ordem: string[] = [];
    orcamentoRepository.aprovarComPagamento.mockImplementation(() => {
      ordem.push('gravou');
      return Promise.resolve(true);
    });
    publicador.publicar.mockImplementation(() => {
      ordem.push('publicou');
      return Promise.resolve();
    });

    await useCase.execute(ordemServicoId);
    expect(ordem).toEqual(['gravou', 'publicou']);
  });

  it('aprovar de novo um orçamento APPROVED devolve o mesmo link sem republicar', async () => {
    orcamentoRepository.findByOrdemServicoId.mockResolvedValue(orcamento(StatusOrcamento.APPROVED));
    pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
      pagamentoExistente('https://mp/pref-antiga')
    );

    await expect(useCase.execute(ordemServicoId)).resolves.toEqual({
      linkPagamento: 'https://mp/pref-antiga',
    });
    expect(gateway.criarCobranca).not.toHaveBeenCalled();
    expect(orcamentoRepository.aprovarComPagamento).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
  });

  it('aprovar orçamento REJECTED é erro de domínio, sem cobrança', async () => {
    orcamentoRepository.findByOrdemServicoId.mockResolvedValue(orcamento(StatusOrcamento.REJECTED));

    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(DomainException);
    expect(gateway.criarCobranca).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
  });

  it('falha do Mercado Pago propaga o 502 e não grava nada (orçamento segue PENDING)', async () => {
    gateway.criarCobranca.mockRejectedValue(new BadGatewayException());

    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(BadGatewayException);
    expect(orcamentoRepository.aprovarComPagamento).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
  });

  it('aprovação concorrente: devolve o link de quem gravou primeiro, sem publicar', async () => {
    orcamentoRepository.aprovarComPagamento.mockResolvedValue(false);
    pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
      pagamentoExistente('https://mp/vencedor')
    );

    await expect(useCase.execute(ordemServicoId)).resolves.toEqual({
      linkPagamento: 'https://mp/vencedor',
    });
    expect(publicador.publicar).not.toHaveBeenCalled();
  });

  it('orçamento APPROVED sem cobrança gravada vira conflito', async () => {
    orcamentoRepository.findByOrdemServicoId.mockResolvedValue(orcamento(StatusOrcamento.APPROVED));
    pagamentoRepository.findByOrdemServicoId.mockResolvedValue(pagamentoExistente(null));

    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(ConflitoException);
  });

  it('orçamento inexistente vira 404', async () => {
    orcamentoRepository.findByOrdemServicoId.mockResolvedValue(null);

    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(EntityNotFoundException);
  });
});
