import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';
import { Orcamento, StatusOrcamento } from './orcamento.entity';

describe('Orcamento', () => {
  const ordemServicoId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const totais = { valorTotalServicos: 450, valorTotalPecas: 320.5, valorTotalGeral: 770.5 };

  const comStatus = (status: StatusOrcamento, valorTotalGeral = 770.5) =>
    Orcamento.reconstituir({ id: 'orc-1', ordemServicoId, ...totais, valorTotalGeral, status });

  it('nasce PENDING com os totais como vieram', () => {
    const orcamento = Orcamento.criar(ordemServicoId, totais);
    expect(orcamento.getId()).toEqual(expect.any(String));
    expect(orcamento.getOrdemServicoId()).toBe(ordemServicoId);
    expect(orcamento.getStatus()).toBe(StatusOrcamento.PENDING);
    expect(orcamento.getValorTotalServicos()).toBe(450);
    expect(orcamento.getValorTotalPecas()).toBe(320.5);
    expect(orcamento.getValorTotalGeral()).toBe(770.5);
  });

  it('não recalcula o total geral a partir das parcelas', () => {
    const orcamento = Orcamento.criar(ordemServicoId, { ...totais, valorTotalGeral: 999.99 });
    expect(orcamento.getValorTotalGeral()).toBe(999.99);
  });

  it.each([
    { valorTotalServicos: -1 },
    { valorTotalPecas: -0.01 },
    { valorTotalGeral: Number.NaN },
  ])('recusa total inválido %o', (invalido) => {
    expect(() => Orcamento.criar(ordemServicoId, { ...totais, ...invalido })).toThrow(
      DomainException
    );
  });

  it('aprova orçamento pendente', () => {
    const orcamento = comStatus(StatusOrcamento.PENDING);
    orcamento.aprovar();
    expect(orcamento.getStatus()).toBe(StatusOrcamento.APPROVED);
    expect(orcamento.estaAprovado()).toBe(true);
  });

  it('não aprova orçamento sem valor', () => {
    expect(() => comStatus(StatusOrcamento.PENDING, 0).aprovar()).toThrow('sem valores definidos');
  });

  it('não aprova orçamento já recusado', () => {
    expect(() => comStatus(StatusOrcamento.REJECTED).aprovar()).toThrow(
      'Só é possível aprovar um orçamento pendente. Status atual: REJECTED'
    );
  });

  it('recusa orçamento pendente', () => {
    const orcamento = comStatus(StatusOrcamento.PENDING);
    orcamento.recusar();
    expect(orcamento.getStatus()).toBe(StatusOrcamento.REJECTED);
    expect(orcamento.estaPendente()).toBe(false);
  });

  it('não recusa orçamento já aprovado', () => {
    expect(() => comStatus(StatusOrcamento.APPROVED).recusar()).toThrow(DomainException);
  });

  it('atualiza totais enquanto pendente', () => {
    const orcamento = comStatus(StatusOrcamento.PENDING);
    orcamento.atualizarTotais({ valorTotalServicos: 1, valorTotalPecas: 2, valorTotalGeral: 3 });
    expect(orcamento.getValorTotalGeral()).toBe(3);
  });

  it('não atualiza totais de orçamento aprovado', () => {
    expect(() => comStatus(StatusOrcamento.APPROVED).atualizarTotais(totais)).toThrow(
      DomainException
    );
  });
});
