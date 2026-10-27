import { Prisma } from '@prisma/client';
import type { Orcamento as OrcamentoRecord, Pagamento as PagamentoRecord } from '@prisma/client';
import { Orcamento, StatusOrcamento } from '../../domain/entities/orcamento.entity';
import { Pagamento, StatusPagamento } from '../../domain/entities/pagamento.entity';

// Decimal do Prisma fica na infraestrutura; o domínio trabalha com number.
export class OrcamentoMapper {
  static toDomain(record: OrcamentoRecord): Orcamento {
    return Orcamento.reconstituir({
      id: record.id,
      ordemServicoId: record.ordemServicoId,
      valorTotalServicos: record.valorTotalServicos.toNumber(),
      valorTotalPecas: record.valorTotalPecas.toNumber(),
      valorTotalGeral: record.valorTotalGeral.toNumber(),
      status: record.status as StatusOrcamento,
    });
  }

  static totais(
    orcamento: Orcamento
  ): Pick<
    Prisma.OrcamentoUncheckedCreateInput,
    'valorTotalServicos' | 'valorTotalPecas' | 'valorTotalGeral'
  > {
    return {
      valorTotalServicos: new Prisma.Decimal(orcamento.getValorTotalServicos()),
      valorTotalPecas: new Prisma.Decimal(orcamento.getValorTotalPecas()),
      valorTotalGeral: new Prisma.Decimal(orcamento.getValorTotalGeral()),
    };
  }

  static toCreate(orcamento: Orcamento): Prisma.OrcamentoUncheckedCreateInput {
    return {
      id: orcamento.getId(),
      ordemServicoId: orcamento.getOrdemServicoId(),
      ...OrcamentoMapper.totais(orcamento),
      status: orcamento.getStatus(),
    };
  }
}

export class PagamentoMapper {
  static toDomain(record: PagamentoRecord): Pagamento {
    return Pagamento.reconstituir({
      id: record.id,
      ordemServicoId: record.ordemServicoId,
      valor: record.valor.toNumber(),
      status: record.status as StatusPagamento,
      preferenceId: record.preferenceId,
      linkPagamento: record.linkPagamento,
    });
  }

  static toCreate(pagamento: Pagamento): Prisma.PagamentoUncheckedCreateInput {
    return {
      id: pagamento.getId(),
      ordemServicoId: pagamento.getOrdemServicoId(),
      valor: new Prisma.Decimal(pagamento.getValor()),
      status: pagamento.getStatus(),
      preferenceId: pagamento.getPreferenceId(),
      linkPagamento: pagamento.getLinkPagamento(),
    };
  }
}
