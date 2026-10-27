import { DomainException } from '../../../../shared/domain/exceptions/domain.exception';

// Mesmos valores do enum EstimateStatus do schema.
export enum StatusOrcamento {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export interface TotaisOrcamento {
  valorTotalServicos: number;
  valorTotalPecas: number;
  valorTotalGeral: number;
}

interface OrcamentoProps extends TotaisOrcamento {
  id: string;
  ordemServicoId: string;
  status: StatusOrcamento;
}

// Os totais chegam prontos no OrcamentoCalculado (o OS Service é dono dos itens) e ficam
// congelados como vieram: o Billing não recalcula nem confere a soma.
export class Orcamento {
  private constructor(private props: OrcamentoProps) {}

  static criar(ordemServicoId: string, totais: TotaisOrcamento): Orcamento {
    Orcamento.validarTotais(totais);
    return new Orcamento({
      id: crypto.randomUUID(),
      ordemServicoId,
      ...totais,
      status: StatusOrcamento.PENDING,
    });
  }

  static reconstituir(props: OrcamentoProps): Orcamento {
    return new Orcamento({ ...props });
  }

  // OrcamentoCalculado de novo para a mesma OS (mecânico refez a lista) enquanto pendente.
  atualizarTotais(totais: TotaisOrcamento): void {
    this.exigirPendente('atualizar');
    Orcamento.validarTotais(totais);
    this.props = { ...this.props, ...totais };
  }

  aprovar(): void {
    this.exigirPendente('aprovar');
    if (this.props.valorTotalGeral <= 0) {
      throw new DomainException('Não é possível aprovar orçamento sem valores definidos.');
    }
    this.props.status = StatusOrcamento.APPROVED;
  }

  recusar(): void {
    this.exigirPendente('recusar');
    this.props.status = StatusOrcamento.REJECTED;
  }

  estaPendente(): boolean {
    return this.props.status === StatusOrcamento.PENDING;
  }

  estaAprovado(): boolean {
    return this.props.status === StatusOrcamento.APPROVED;
  }

  getId(): string {
    return this.props.id;
  }
  getOrdemServicoId(): string {
    return this.props.ordemServicoId;
  }
  getStatus(): StatusOrcamento {
    return this.props.status;
  }
  getValorTotalServicos(): number {
    return this.props.valorTotalServicos;
  }
  getValorTotalPecas(): number {
    return this.props.valorTotalPecas;
  }
  getValorTotalGeral(): number {
    return this.props.valorTotalGeral;
  }

  private exigirPendente(acao: string): void {
    if (!this.estaPendente()) {
      throw new DomainException(
        `Só é possível ${acao} um orçamento pendente. Status atual: ${this.props.status}`
      );
    }
  }

  private static validarTotais(totais: TotaisOrcamento): void {
    const valores = [totais.valorTotalServicos, totais.valorTotalPecas, totais.valorTotalGeral];
    if (valores.some((valor) => !Number.isFinite(valor) || valor < 0)) {
      throw new DomainException('Valores do orçamento não podem ser negativos.');
    }
  }
}
