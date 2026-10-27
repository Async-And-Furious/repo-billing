import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/database/prisma.service';
import { PagamentoMapper } from '../persistence/financeiro.mapper';
import type { Pagamento } from '../../domain/entities/pagamento.entity';
import type { IPagamentoRepository } from '../../domain/interfaces/financeiro.interfaces';

@Injectable()
export class PagamentoRepository implements IPagamentoRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOrdemServicoId(ordemServicoId: string): Promise<Pagamento | null> {
    const record = await this.prisma.pagamento.findUnique({ where: { ordemServicoId } });
    return record ? PagamentoMapper.toDomain(record) : null;
  }
}
