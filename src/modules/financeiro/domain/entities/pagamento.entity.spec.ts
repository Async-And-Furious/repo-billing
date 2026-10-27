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
  });

  it.each([0, -10, Number.NaN])('recusa valor %p', (valor) => {
    expect(() => Pagamento.criar(ordemServicoId, valor, cobranca)).toThrow(DomainException);
  });

  it.each([
    ['confirmar', StatusPagamento.CONFIRMADO],
    ['recusar', StatusPagamento.RECUSADO],
    ['cancelar', StatusPagamento.CANCELADO],
  ] as const)('%s a partir de AGUARDANDO_PAGAMENTO', (acao, esperado) => {
    const pagamento = comStatus(StatusPagamento.AGUARDANDO_PAGAMENTO);
    pagamento[acao]();
    expect(pagamento.getStatus()).toBe(esperado);
  });

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
