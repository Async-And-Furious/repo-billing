import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';
import { Pagamento, StatusPagamento } from './pagamento.entity';

describe('Pagamento', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const cobranca = { preferenceId: 'pref-1', linkPagamento: 'https://mp/pref-1' };

  const comStatus = (status: StatusPagamento) =>
    Pagamento.reconstituir({
      id: 'pag-1',
      ordemServicoId,
      valor: 100,
      status,
      preferenceId: null,
      linkPagamento: null,
      pagamentoExternoId: null,
      criadoEm: new Date('2026-10-27T10:00:00Z'),
      atualizadoEm: new Date('2026-10-27T10:00:00Z'),
    });

  it('nasce AGUARDANDO_PAGAMENTO com a cobrança vinculada', () => {
    const pagamento = Pagamento.criar(ordemServicoId, 770.5, cobranca);
    expect(pagamento.getId()).toEqual(expect.any(String));
    expect(pagamento.getOrdemServicoId()).toBe(ordemServicoId);
    expect(pagamento.getValor()).toBe(770.5);
    expect(pagamento.getStatus()).toBe(StatusPagamento.AGUARDANDO_PAGAMENTO);
    expect(pagamento.estaPendente()).toBe(true);
    expect(pagamento.getPreferenceId()).toBe('pref-1');
    expect(pagamento.getLinkPagamento()).toBe('https://mp/pref-1');
    expect(pagamento.getPagamentoExternoId()).toBeNull();
    expect(pagamento.getCriadoEm()).toBeInstanceOf(Date);
    expect(pagamento.getAtualizadoEm()).toEqual(pagamento.getCriadoEm());
  });

  it.each([0, -10, Number.NaN])('recusa valor %p', (valor) => {
    expect(() => Pagamento.criar(ordemServicoId, valor, cobranca)).toThrow(DomainException);
  });

  it('cancela a partir de AGUARDANDO_PAGAMENTO', () => {
    const pagamento = comStatus(StatusPagamento.AGUARDANDO_PAGAMENTO);
    pagamento.cancelar();
    expect(pagamento.getStatus()).toBe(StatusPagamento.CANCELADO);
  });

  it.each([
    ['confirmar', StatusPagamento.CONFIRMADO],
    ['recusar', StatusPagamento.RECUSADO],
  ] as const)('%s guarda o id do pagamento no Mercado Pago', (acao, esperado) => {
    const pagamento = comStatus(StatusPagamento.AGUARDANDO_PAGAMENTO);
    pagamento[acao]('mp-123');
    expect(pagamento.getStatus()).toBe(esperado);
    expect(pagamento.getPagamentoExternoId()).toBe('mp-123');
  });

  it.each([StatusPagamento.CONFIRMADO, StatusPagamento.RECUSADO, StatusPagamento.CANCELADO])(
    'não confirma nem recusa pagamento %s, e não grava o id externo',
    (status) => {
      const pagamento = comStatus(status);
      expect(() => pagamento.confirmar('mp-123')).toThrow(DomainException);
      expect(() => pagamento.recusar('mp-123')).toThrow(DomainException);
      expect(pagamento.getPagamentoExternoId()).toBeNull();
    }
  );

  it('estorna pagamento confirmado', () => {
    const pagamento = comStatus(StatusPagamento.CONFIRMADO);
    pagamento.estornar();
    expect(pagamento.getStatus()).toBe(StatusPagamento.ESTORNADO);
  });

  it('não estorna pagamento que não foi confirmado', () => {
    expect(() => comStatus(StatusPagamento.AGUARDANDO_PAGAMENTO).estornar()).toThrow(
      'Pagamento não pode passar de AGUARDANDO_PAGAMENTO para ESTORNADO.'
    );
  });

  it.each([StatusPagamento.CONFIRMADO, StatusPagamento.RECUSADO, StatusPagamento.ESTORNADO])(
    'não cancela pagamento %s',
    (status) => {
      expect(() => comStatus(status).cancelar()).toThrow(DomainException);
    }
  );
});
