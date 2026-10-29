import { Injectable } from '@nestjs/common';
import { EstimateStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/infrastructure/database/prisma.service';
import { OrcamentoMapper, PagamentoMapper } from '../persistence/financeiro.mapper';
import { violouUnicidade } from '../persistence/prisma-errors';
import type { Orcamento } from '../../domain/entities/orcamento.entity';
import type { Pagamento } from '../../domain/entities/pagamento.entity';
import type { IOrcamentoRepository } from '../../domain/interfaces/financeiro.interfaces';

@Injectable()
export class OrcamentoRepository implements IOrcamentoRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOrdemServicoId(ordemServicoId: string): Promise<Orcamento | null> {
    const record = await this.prisma.orcamento.findUnique({ where: { ordemServicoId } });
    return record ? OrcamentoMapper.toDomain(record) : null;
  }

  async criar(orcamento: Orcamento): Promise<void> {
    await this.prisma.orcamento.create({ data: OrcamentoMapper.toCreate(orcamento) });
  }

  async atualizarTotaisSePendente(orcamento: Orcamento): Promise<boolean> {
    const { count } = await this.prisma.orcamento.updateMany({
      where: { id: orcamento.getId(), status: EstimateStatus.PENDING },
      data: OrcamentoMapper.totais(orcamento),
    });
    return count > 0;
  }

  async aprovarComPagamento(orcamento: Orcamento, pagamento: Pagamento): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.orcamento.updateMany({
          where: { id: orcamento.getId(), status: EstimateStatus.PENDING },
          data: { status: EstimateStatus.APPROVED },
        });
        if (count === 0) {
          return false;
        }
        await tx.pagamento.create({ data: PagamentoMapper.toCreate(pagamento) });
        return true;
      });
    } catch (error) {
      // A OS já tem pagamento: a transação desfaz a aprovação e quem chegou antes vence.
      if (violouUnicidade(error)) {
        return false;
      }
      throw error;
    }
  }

  // Só desfaz reserva sem cobrança: o linkPagamento nulo garante que nada já foi pago ou exibido.
  async desfazerAprovacao(orcamento: Orcamento, pagamento: Pagamento): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.pagamento.deleteMany({ where: { id: pagamento.getId(), linkPagamento: null } });
      await tx.orcamento.updateMany({
        where: { id: orcamento.getId(), status: EstimateStatus.APPROVED },
        data: { status: EstimateStatus.PENDING },
      });
    });
  }

  async recusarSePendente(orcamento: Orcamento): Promise<boolean> {
    const { count } = await this.prisma.orcamento.updateMany({
      where: { id: orcamento.getId(), status: EstimateStatus.PENDING },
      data: { status: EstimateStatus.REJECTED },
    });
    return count > 0;
  }
}
