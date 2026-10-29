import { BadGatewayException } from '@nestjs/common';
import { ConflitoException } from '../../../../shared/domain/exceptions/conflito.exception';
import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';
import { EntityNotFoundException } from '../../../../shared/domain/exceptions/entity-not-found.exception';
import { Orcamento, StatusOrcamento } from '../../domain/entities/orcamento.entity';
import { Pagamento, StatusPagamento, type Cobranca } from '../../domain/entities/pagamento.entity';
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
      preferenceId: linkPagamento ? 'pref-antiga' : null,
      linkPagamento,
      pagamentoExternoId: null,
      criadoEm: new Date('2026-10-27T10:00:00Z'),
      atualizadoEm: new Date('2026-10-27T10:00:00Z'),
    });

  // Espera o use case chegar à chamada do Mercado Pago (o pedido fica "em voo" até a resposta).
  const aguardarChamadaMp = async () => {
    while (gateway.criarCobranca.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  beforeEach(() => {
    orcamentoRepository = {
      findByOrdemServicoId: jest
        .fn()
        .mockImplementation(() => Promise.resolve(orcamento(StatusOrcamento.PENDING))),
      criar: jest.fn(),
      atualizarTotaisSePendente: jest.fn(),
      aprovarComPagamento: jest.fn().mockResolvedValue(true),
      desfazerAprovacao: jest.fn().mockResolvedValue(undefined),
      recusarSePendente: jest.fn(),
    };
    pagamentoRepository = {
      findByOrdemServicoId: jest.fn().mockResolvedValue(null),
      salvarCobranca: jest.fn().mockResolvedValue(undefined),
      salvarComNotificacao: jest.fn(),
      jaRecebida: jest.fn(),
      registrar: jest.fn(),
    };
    gateway = {
      criarCobranca: jest.fn().mockResolvedValue(cobranca),
      consultarPagamento: jest.fn(),
      estornar: jest.fn(),
    };
    publicador = { publicar: jest.fn().mockResolvedValue(undefined) };
    useCase = new AprovarOrcamentoUseCase(
      orcamentoRepository,
      pagamentoRepository,
      gateway,
      publicador
    );
  });

  it('reserva o pagamento, cria a cobrança com o total geral, grava o link e publica OrcamentoAprovado', async () => {
    await expect(useCase.execute(ordemServicoId)).resolves.toEqual({
      linkPagamento: 'https://mp/pref-1',
    });

    expect(gateway.criarCobranca).toHaveBeenCalledWith(ordemServicoId, 770.5);
    const [aprovado, reservado] = orcamentoRepository.aprovarComPagamento.mock.calls[0];
    expect(aprovado.getStatus()).toBe(StatusOrcamento.APPROVED);
    expect(reservado.getStatus()).toBe(StatusPagamento.AGUARDANDO_PAGAMENTO);
    expect(reservado.getValor()).toBe(770.5);
    expect(pagamentoRepository.salvarCobranca).toHaveBeenCalledWith(reservado);
    expect(reservado.getPreferenceId()).toBe('pref-1');
    expect(reservado.getLinkPagamento()).toBe('https://mp/pref-1');
    expect(publicador.publicar).toHaveBeenCalledWith(
      new OrcamentoAprovado(ordemServicoId, 'orc-1', 320.5)
    );
  });

  it('reserva antes de chamar o Mercado Pago e grava o link antes de publicar', async () => {
    const ordem: string[] = [];
    orcamentoRepository.aprovarComPagamento.mockImplementation(() => {
      ordem.push('reservou');
      return Promise.resolve(true);
    });
    gateway.criarCobranca.mockImplementation(() => {
      ordem.push('mercado pago');
      return Promise.resolve(cobranca);
    });
    pagamentoRepository.salvarCobranca.mockImplementation(() => {
      ordem.push('gravou o link');
      return Promise.resolve();
    });
    publicador.publicar.mockImplementation(() => {
      ordem.push('publicou');
      return Promise.resolve();
    });

    await useCase.execute(ordemServicoId);
    expect(ordem).toEqual(['reservou', 'mercado pago', 'gravou o link', 'publicou']);
  });

  it('a reserva é gravada sem cobrança, antes da chamada ao Mercado Pago', async () => {
    let linkNaReserva: string | null | undefined;
    orcamentoRepository.aprovarComPagamento.mockImplementation((_orcamento, pagamento) => {
      linkNaReserva = pagamento.getLinkPagamento();
      return Promise.resolve(true);
    });

    await useCase.execute(ordemServicoId);
    expect(linkNaReserva).toBeNull();
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

  it('aprovar orçamento REJECTED é erro de domínio, sem reserva nem cobrança', async () => {
    orcamentoRepository.findByOrdemServicoId.mockResolvedValue(orcamento(StatusOrcamento.REJECTED));

    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(DomainException);
    expect(orcamentoRepository.aprovarComPagamento).not.toHaveBeenCalled();
    expect(gateway.criarCobranca).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
  });

  it('falha do Mercado Pago desfaz a reserva, propaga o 502 e não publica nada', async () => {
    gateway.criarCobranca.mockRejectedValue(new BadGatewayException());

    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(BadGatewayException);
    expect(orcamentoRepository.desfazerAprovacao).toHaveBeenCalledTimes(1);
    const [desfeito, reservaDesfeita] = orcamentoRepository.desfazerAprovacao.mock.calls[0];
    expect(desfeito.getId()).toBe('orc-1');
    expect(reservaDesfeita.getLinkPagamento()).toBeNull();
    expect(pagamentoRepository.salvarCobranca).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
  });

  it('depois de uma falha do Mercado Pago, a próxima aprovação reserva e cobra de novo', async () => {
    gateway.criarCobranca.mockRejectedValueOnce(new BadGatewayException());
    await expect(useCase.execute(ordemServicoId)).rejects.toThrow(BadGatewayException);

    await expect(useCase.execute(ordemServicoId)).resolves.toEqual({
      linkPagamento: 'https://mp/pref-1',
    });
    expect(gateway.criarCobranca).toHaveBeenCalledTimes(2);
    expect(orcamentoRepository.aprovarComPagamento).toHaveBeenCalledTimes(2);
  });

  describe('aprovações concorrentes (repositório simulado com as transições condicionais)', () => {
    // Estado "banco": a reserva é um insert condicional (só o primeiro ganha), como no Postgres.
    let banco: { status: StatusOrcamento; pagamento: Pagamento | null };
    let resolverMp: (cobranca: Cobranca) => void;

    beforeEach(() => {
      banco = { status: StatusOrcamento.PENDING, pagamento: null };
      orcamentoRepository.findByOrdemServicoId.mockImplementation(() =>
        Promise.resolve(orcamento(banco.status))
      );
      orcamentoRepository.aprovarComPagamento.mockImplementation((_orcamento, pagamento) => {
        if (banco.pagamento) {
          return Promise.resolve(false);
        }
        banco = { status: StatusOrcamento.APPROVED, pagamento };
        return Promise.resolve(true);
      });
      pagamentoRepository.findByOrdemServicoId.mockImplementation(() =>
        Promise.resolve(banco.pagamento)
      );
      pagamentoRepository.salvarCobranca.mockResolvedValue(undefined);
      // A resposta do Mercado Pago fica pendente até o teste liberá-la.
      gateway.criarCobranca.mockImplementation(
        () => new Promise<Cobranca>((resolve) => (resolverMp = resolve))
      );
    });

    it('enquanto o vencedor espera o Mercado Pago, a concorrente não chama o gateway e recebe 409', async () => {
      const vencedora = useCase.execute(ordemServicoId);
      await aguardarChamadaMp();

      await expect(useCase.execute(ordemServicoId)).rejects.toThrow(ConflitoException);
      expect(gateway.criarCobranca).toHaveBeenCalledTimes(1);

      resolverMp(cobranca);
      await expect(vencedora).resolves.toEqual({ linkPagamento: 'https://mp/pref-1' });
      expect(publicador.publicar).toHaveBeenCalledTimes(1);
    });

    it('duas aprovações simultâneas geram uma única preference e um único OrcamentoAprovado', async () => {
      const primeira = useCase.execute(ordemServicoId);
      const segunda = useCase.execute(ordemServicoId);
      // Os dois pedidos já estão observados antes de qualquer rejeição, para não virar rejeição não tratada.
      const liquidados = Promise.allSettled([primeira, segunda]);
      await aguardarChamadaMp();
      resolverMp(cobranca);

      // A primeira chamada é a que ganha a reserva; a segunda vira 409 enquanto a cobrança não é gravada.
      const [vencedora, perdedora] = await liquidados;
      expect(vencedora).toEqual({
        status: 'fulfilled',
        value: { linkPagamento: 'https://mp/pref-1' },
      });
      expect(perdedora).toMatchObject({
        status: 'rejected',
        reason: expect.any(ConflitoException),
      });
      expect(gateway.criarCobranca).toHaveBeenCalledTimes(1);
      expect(publicador.publicar).toHaveBeenCalledTimes(1);
    });

    it('após a gravação do link, a aprovação concorrente devolve o mesmo link', async () => {
      const vencedora = useCase.execute(ordemServicoId);
      await aguardarChamadaMp();
      resolverMp(cobranca);
      await vencedora;

      await expect(useCase.execute(ordemServicoId)).resolves.toEqual({
        linkPagamento: 'https://mp/pref-1',
      });
      expect(gateway.criarCobranca).toHaveBeenCalledTimes(1);
    });
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
