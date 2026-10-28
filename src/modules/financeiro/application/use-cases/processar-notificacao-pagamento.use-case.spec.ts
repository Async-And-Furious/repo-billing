import { BadGatewayException } from '@nestjs/common';
import { ConflitoException } from '../../../../shared/domain/exceptions/conflito.exception';
import { Pagamento, StatusPagamento } from '../../domain/entities/pagamento.entity';
import { PagamentoConfirmado, PagamentoRecusado } from '../../domain/events/pagamento.events';
import type {
  IGatewayPagamento,
  IPagamentoRepository,
  IPublicadorEventos,
  PagamentoExterno,
} from '../../domain/interfaces/financeiro.interfaces';
import { ProcessarNotificacaoPagamentoUseCase } from './processar-notificacao-pagamento.use-case';

describe('ProcessarNotificacaoPagamentoUseCase', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  let pagamentoRepository: jest.Mocked<IPagamentoRepository>;
  let gateway: jest.Mocked<IGatewayPagamento>;
  let publicador: jest.Mocked<IPublicadorEventos>;
  let useCase: ProcessarNotificacaoPagamentoUseCase;

  const pagamento = (status: StatusPagamento, pagamentoExternoId: string | null = null) =>
    Pagamento.reconstituir({
      id: 'pag-1',
      ordemServicoId,
      valor: 770.5,
      status,
      preferenceId: 'pref-1',
      linkPagamento: 'https://mp/pref-1',
      pagamentoExternoId,
      criadoEm: new Date('2026-10-27T10:00:00Z'),
      atualizadoEm: new Date('2026-10-27T10:00:00Z'),
    });

  const externo = (sobrescrever: Partial<PagamentoExterno> = {}): PagamentoExterno => ({
    id: 'mp-1',
    status: 'approved',
    referenciaExterna: ordemServicoId,
    valor: 770.5,
    ...sobrescrever,
  });

  const doRepositorio = () => pagamentoRepository.salvarComNotificacao.mock.calls[0];

  beforeEach(() => {
    pagamentoRepository = {
      findByOrdemServicoId: jest
        .fn()
        .mockResolvedValue(pagamento(StatusPagamento.AGUARDANDO_PAGAMENTO)),
      salvarComNotificacao: jest.fn().mockResolvedValue(true),
      jaRecebida: jest.fn().mockResolvedValue(false),
      registrar: jest.fn().mockResolvedValue(true),
    };
    gateway = {
      criarCobranca: jest.fn(),
      consultarPagamento: jest.fn().mockResolvedValue(externo()),
      estornar: jest.fn().mockResolvedValue(undefined),
    };
    publicador = { publicar: jest.fn().mockResolvedValue(undefined) };
    useCase = new ProcessarNotificacaoPagamentoUseCase(pagamentoRepository, gateway, publicador);
  });

  describe('approved', () => {
    it('confirma o Pagamento e publica PagamentoConfirmado depois de gravar', async () => {
      const ordem: string[] = [];
      pagamentoRepository.salvarComNotificacao.mockImplementation(() => {
        ordem.push('gravou');
        return Promise.resolve(true);
      });
      publicador.publicar.mockImplementation(() => {
        ordem.push('publicou');
        return Promise.resolve();
      });

      await expect(useCase.execute('mp-1')).resolves.toBe('CONFIRMADO');

      expect(gateway.consultarPagamento).toHaveBeenCalledWith('mp-1');
      const [confirmado, statusAnterior, notificacao] = doRepositorio();
      expect(confirmado.getStatus()).toBe(StatusPagamento.CONFIRMADO);
      expect(confirmado.getPagamentoExternoId()).toBe('mp-1');
      expect(statusAnterior).toBe(StatusPagamento.AGUARDANDO_PAGAMENTO);
      expect(notificacao).toEqual({ providerEventId: 'mp-1', tipo: 'payment.approved' });
      expect(publicador.publicar).toHaveBeenCalledWith(
        new PagamentoConfirmado(ordemServicoId, 'pag-1')
      );
      expect(ordem).toEqual(['gravou', 'publicou']);
    });

    it('compara o valor em centavos: ruído de ponto flutuante não diverge', async () => {
      gateway.consultarPagamento.mockResolvedValue(externo({ valor: 770.5000000000001 }));
      await expect(useCase.execute('mp-1')).resolves.toBe('CONFIRMADO');
    });

    it('um centavo de diferença diverge, sem depender do erro de ponto flutuante', async () => {
      // 10.01 - 10 = 0.00999...: uma tolerância "< 0,01" aceitaria este valor.
      pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
        Pagamento.reconstituir({
          id: 'pag-1',
          ordemServicoId,
          valor: 10,
          status: StatusPagamento.AGUARDANDO_PAGAMENTO,
          preferenceId: 'pref-1',
          linkPagamento: 'https://mp/pref-1',
          pagamentoExternoId: null,
          criadoEm: new Date('2026-10-27T10:00:00Z'),
          atualizadoEm: new Date('2026-10-27T10:00:00Z'),
        })
      );
      gateway.consultarPagamento.mockResolvedValue(externo({ valor: 10.01 }));

      await expect(useCase.execute('mp-1')).resolves.toBe('VALOR_DIVERGENTE');
      expect(pagamentoRepository.salvarComNotificacao).not.toHaveBeenCalled();
    });

    it('valor divergente: não confirma, não grava e não publica', async () => {
      gateway.consultarPagamento.mockResolvedValue(externo({ valor: 1 }));

      await expect(useCase.execute('mp-1')).resolves.toBe('VALOR_DIVERGENTE');
      expect(pagamentoRepository.salvarComNotificacao).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('valor ausente na reconsulta também não confirma', async () => {
      gateway.consultarPagamento.mockResolvedValue(externo({ valor: null }));

      await expect(useCase.execute('mp-1')).resolves.toBe('VALOR_DIVERGENTE');
      expect(pagamentoRepository.salvarComNotificacao).not.toHaveBeenCalled();
    });

    it('reentrega depois de confirmado: sem gravar nem publicar de novo', async () => {
      pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
        pagamento(StatusPagamento.CONFIRMADO, 'mp-1')
      );

      await expect(useCase.execute('mp-1')).resolves.toBe('JA_PROCESSADO');
      expect(pagamentoRepository.salvarComNotificacao).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('entregas simultâneas: quem perde a corrida no banco não publica', async () => {
      pagamentoRepository.salvarComNotificacao.mockResolvedValue(false);
      pagamentoRepository.findByOrdemServicoId
        .mockResolvedValueOnce(pagamento(StatusPagamento.AGUARDANDO_PAGAMENTO))
        .mockResolvedValueOnce(pagamento(StatusPagamento.CONFIRMADO, 'mp-1'));

      await expect(useCase.execute('mp-1')).resolves.toBe('JA_PROCESSADO');
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('Pagamento cancelado no meio do caminho: não dá por processado, o 409 faz o MP reenviar', async () => {
      pagamentoRepository.salvarComNotificacao.mockResolvedValue(false);
      pagamentoRepository.findByOrdemServicoId
        .mockResolvedValueOnce(pagamento(StatusPagamento.AGUARDANDO_PAGAMENTO))
        .mockResolvedValueOnce(pagamento(StatusPagamento.CANCELADO));

      await expect(useCase.execute('mp-1')).rejects.toThrow(ConflitoException);
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('falha ao gravar propaga o erro (MP reenvia) e não publica', async () => {
      pagamentoRepository.salvarComNotificacao.mockRejectedValue(new Error('banco fora'));

      await expect(useCase.execute('mp-1')).rejects.toThrow('banco fora');
      expect(publicador.publicar).not.toHaveBeenCalled();
    });
  });

  describe('approved indevido: estorna pelo gateway, sem confirmar nem publicar', () => {
    const notificacaoAprovada = { providerEventId: 'mp-1', tipo: 'payment.approved' };

    // O Pagamento original nunca é regravado: nem status, nem id do pagamento original.
    const semTocarNoPagamento = () => {
      expect(pagamentoRepository.salvarComNotificacao).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    };

    describe('pagamento atrasado (Pagamento já CANCELADO)', () => {
      beforeEach(() => {
        pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
          pagamento(StatusPagamento.CANCELADO)
        );
      });

      it('estorna, registra a notificação e NÃO publica PagamentoConfirmado', async () => {
        await expect(useCase.execute('mp-1')).resolves.toBe('ESTORNADO_PAGAMENTO_ATRASADO');

        expect(gateway.estornar).toHaveBeenCalledWith('mp-1');
        expect(pagamentoRepository.registrar).toHaveBeenCalledWith(notificacaoAprovada);
        semTocarNoPagamento();
      });

      it('estorna mesmo que o valor tenha divergido: o dinheiro não é da cobrança cancelada', async () => {
        gateway.consultarPagamento.mockResolvedValue(externo({ valor: 1 }));

        await expect(useCase.execute('mp-1')).resolves.toBe('ESTORNADO_PAGAMENTO_ATRASADO');
        expect(gateway.estornar).toHaveBeenCalledWith('mp-1');
      });

      it('segundo pagamento atrasado: estorna e não sobrescreve o id já gravado', async () => {
        pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
          pagamento(StatusPagamento.CANCELADO, 'mp-0')
        );

        await expect(useCase.execute('mp-1')).resolves.toBe('ESTORNADO_PAGAMENTO_ATRASADO');
        expect(gateway.estornar).toHaveBeenCalledWith('mp-1');
        semTocarNoPagamento();
      });
    });

    describe('pagamento em duplicidade', () => {
      it.each([
        [StatusPagamento.RECUSADO, 'cobrança já recusada'],
        [StatusPagamento.CONFIRMADO, 'cobrança já confirmada por outro pagamento'],
        [StatusPagamento.ESTORNADO, 'cobrança já estornada'],
      ])('%s (%s): estorna e não confirma de novo', async (status) => {
        pagamentoRepository.findByOrdemServicoId.mockResolvedValue(pagamento(status, 'mp-0'));

        await expect(useCase.execute('mp-1')).resolves.toBe('ESTORNADO_PAGAMENTO_DUPLICADO');

        expect(gateway.estornar).toHaveBeenCalledWith('mp-1');
        expect(pagamentoRepository.registrar).toHaveBeenCalledWith(notificacaoAprovada);
        semTocarNoPagamento();
      });
    });

    describe.each([
      [StatusPagamento.CANCELADO, null],
      [StatusPagamento.RECUSADO, 'mp-0'],
      [StatusPagamento.CONFIRMADO, 'mp-0'],
    ])('idempotência e falhas com o Pagamento %s', (status, idExterno) => {
      beforeEach(() => {
        pagamentoRepository.findByOrdemServicoId.mockResolvedValue(pagamento(status, idExterno));
      });

      it('reentrega depois do estorno registrado: não estorna de novo', async () => {
        pagamentoRepository.jaRecebida.mockResolvedValue(true);

        await expect(useCase.execute('mp-1')).resolves.toBe('JA_PROCESSADO');
        expect(pagamentoRepository.jaRecebida).toHaveBeenCalledWith(notificacaoAprovada);
        expect(gateway.estornar).not.toHaveBeenCalled();
        expect(pagamentoRepository.registrar).not.toHaveBeenCalled();
      });

      it('estorno falhou: 502 sobe e nada é gravado (MP reenvia e o estorno é tentado de novo)', async () => {
        gateway.estornar.mockRejectedValue(new BadGatewayException());

        await expect(useCase.execute('mp-1')).rejects.toThrow(BadGatewayException);
        expect(pagamentoRepository.registrar).not.toHaveBeenCalled();
        semTocarNoPagamento();
      });

      it('entregas simultâneas: quem perde a gravação do registro responde JA_PROCESSADO', async () => {
        pagamentoRepository.registrar.mockResolvedValue(false);

        await expect(useCase.execute('mp-1')).resolves.toBe('JA_PROCESSADO');
      });

      it('falha ao gravar o registro depois do estorno sobe (MP reenvia, mesma chave no estorno)', async () => {
        pagamentoRepository.registrar.mockRejectedValue(new Error('banco fora'));

        await expect(useCase.execute('mp-1')).rejects.toThrow('banco fora');
        expect(gateway.estornar).toHaveBeenCalledTimes(1);
      });
    });

    it('mesma notificação de pagamento confirmado por ela mesma: nem consulta o registro', async () => {
      pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
        pagamento(StatusPagamento.CONFIRMADO, 'mp-1')
      );

      await expect(useCase.execute('mp-1')).resolves.toBe('JA_PROCESSADO');
      expect(pagamentoRepository.jaRecebida).not.toHaveBeenCalled();
      expect(gateway.estornar).not.toHaveBeenCalled();
    });
  });

  describe('rejected / cancelled', () => {
    it.each(['rejected', 'cancelled'])(
      '%s recusa o Pagamento e publica PagamentoRecusado',
      async (status) => {
        gateway.consultarPagamento.mockResolvedValue(externo({ status, valor: null }));

        await expect(useCase.execute('mp-1')).resolves.toBe('RECUSADO');

        const [recusado, statusAnterior, notificacao] = doRepositorio();
        expect(recusado.getStatus()).toBe(StatusPagamento.RECUSADO);
        expect(recusado.getPagamentoExternoId()).toBe('mp-1');
        expect(statusAnterior).toBe(StatusPagamento.AGUARDANDO_PAGAMENTO);
        expect(notificacao).toEqual({ providerEventId: 'mp-1', tipo: `payment.${status}` });
        expect(publicador.publicar).toHaveBeenCalledWith(
          new PagamentoRecusado(ordemServicoId, 'pag-1')
        );
      }
    );

    it('reentrega da recusa: sem efeito', async () => {
      gateway.consultarPagamento.mockResolvedValue(externo({ status: 'rejected' }));
      pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
        pagamento(StatusPagamento.RECUSADO, 'mp-1')
      );

      await expect(useCase.execute('mp-1')).resolves.toBe('JA_PROCESSADO');
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('recusa de outro pagamento com a cobrança já encerrada: ignorada', async () => {
      gateway.consultarPagamento.mockResolvedValue(externo({ id: 'mp-2', status: 'rejected' }));
      pagamentoRepository.findByOrdemServicoId.mockResolvedValue(
        pagamento(StatusPagamento.CONFIRMADO, 'mp-1')
      );

      await expect(useCase.execute('mp-2')).resolves.toBe('STATUS_IGNORADO');
      expect(pagamentoRepository.salvarComNotificacao).not.toHaveBeenCalled();
      expect(publicador.publicar).not.toHaveBeenCalled();
    });

    it('perdeu a corrida na gravação: não publica', async () => {
      gateway.consultarPagamento.mockResolvedValue(externo({ status: 'rejected' }));
      pagamentoRepository.salvarComNotificacao.mockResolvedValue(false);
      pagamentoRepository.findByOrdemServicoId
        .mockResolvedValueOnce(pagamento(StatusPagamento.AGUARDANDO_PAGAMENTO))
        .mockResolvedValueOnce(pagamento(StatusPagamento.RECUSADO, 'mp-1'));

      await expect(useCase.execute('mp-1')).resolves.toBe('JA_PROCESSADO');
      expect(publicador.publicar).not.toHaveBeenCalled();
    });
  });

  describe('sem efeito', () => {
    it.each(['pending', 'in_process', 'authorized'])(
      '%s não altera o Pagamento nem publica evento',
      async (status) => {
        gateway.consultarPagamento.mockResolvedValue(externo({ status }));

        await expect(useCase.execute('mp-1')).resolves.toBe('STATUS_IGNORADO');
        expect(pagamentoRepository.salvarComNotificacao).not.toHaveBeenCalled();
        expect(publicador.publicar).not.toHaveBeenCalled();
      }
    );

    it('pagamento desconhecido no Mercado Pago (404)', async () => {
      gateway.consultarPagamento.mockResolvedValue(null);

      await expect(useCase.execute('mp-1')).resolves.toBe('PAGAMENTO_NAO_ENCONTRADO');
      expect(pagamentoRepository.findByOrdemServicoId).not.toHaveBeenCalled();
    });

    it('pagamento sem external_reference', async () => {
      gateway.consultarPagamento.mockResolvedValue(externo({ referenciaExterna: null }));

      await expect(useCase.execute('mp-1')).resolves.toBe('COBRANCA_NAO_ENCONTRADA');
      expect(pagamentoRepository.findByOrdemServicoId).not.toHaveBeenCalled();
    });

    it('external_reference sem cobrança no Billing', async () => {
      pagamentoRepository.findByOrdemServicoId.mockResolvedValue(null);

      await expect(useCase.execute('mp-1')).resolves.toBe('COBRANCA_NAO_ENCONTRADA');
      expect(publicador.publicar).not.toHaveBeenCalled();
    });
  });

  it('falha na reconsulta sobe (502) sem tocar no banco nem publicar', async () => {
    gateway.consultarPagamento.mockRejectedValue(new BadGatewayException());

    await expect(useCase.execute('mp-1')).rejects.toThrow(BadGatewayException);
    expect(pagamentoRepository.findByOrdemServicoId).not.toHaveBeenCalled();
    expect(publicador.publicar).not.toHaveBeenCalled();
  });
});
