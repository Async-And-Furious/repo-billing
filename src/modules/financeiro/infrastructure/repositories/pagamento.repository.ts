import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/database/prisma.service';
import { PagamentoMapper } from '../persistence/financeiro.mapper';
import { violouUnicidade } from '../persistence/prisma-errors';
import type { Pagamento, StatusPagamento } from '../../domain/entities/pagamento.entity';
import type {
  IPagamentoRepository,
  NotificacaoRecebida,
} from '../../domain/interfaces/financeiro.interfaces';

// Faz a transação desfazer o insert do webhook_recebido quando o Pagamento já mudou de status.
class TransicaoConcorrente extends Error {}

@Injectable()
export class PagamentoRepository implements IPagamentoRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOrdemServicoId(ordemServicoId: string): Promise<Pagamento | null> {
    const record = await this.prisma.pagamento.findUnique({ where: { ordemServicoId } });
    return record ? PagamentoMapper.toDomain(record) : null;
  }

  async salvarComNotificacao(
    pagamento: Pagamento,
    statusAnterior: StatusPagamento,
    notificacao: NotificacaoRecebida
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.webhookRecebido.create({
          data: { providerEventId: notificacao.providerEventId, tipo: notificacao.tipo },
        });
        const { count } = await tx.pagamento.updateMany({
          where: { id: pagamento.getId(), status: statusAnterior },
          data: {
            status: pagamento.getStatus(),
            mercadoPagoPaymentId: pagamento.getPagamentoExternoId(),
          },
        });
        if (count === 0) {
          throw new TransicaoConcorrente();
        }
      });
      return true;
    } catch (error) {
      if (violouUnicidade(error) || error instanceof TransicaoConcorrente) {
        return false;
      }
      throw error;
    }
  }

  async jaRecebida(notificacao: NotificacaoRecebida): Promise<boolean> {
    const registro = await this.prisma.webhookRecebido.findUnique({
      where: { providerEventId_tipo: notificacao },
      select: { id: true },
    });
    return registro !== null;
  }

  async registrar(notificacao: NotificacaoRecebida): Promise<boolean> {
    try {
      await this.prisma.webhookRecebido.create({ data: notificacao });
      return true;
    } catch (error) {
      if (violouUnicidade(error)) {
        return false;
      }
      throw error;
    }
  }
}
