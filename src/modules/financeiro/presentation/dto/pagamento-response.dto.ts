import { ApiProperty } from '@nestjs/swagger';
import { StatusPagamento } from '../../domain/entities/pagamento.entity';
import type { Pagamento } from '../../domain/entities/pagamento.entity';

export class PagamentoResponseDto {
  @ApiProperty({ example: '9b2d7c1e-4f3a-4e8b-a1c2-3d4e5f6a7b8c' })
  id!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  ordemServicoId!: string;

  @ApiProperty({ example: 770.5 })
  valor!: number;

  @ApiProperty({ enum: StatusPagamento, example: StatusPagamento.AGUARDANDO_PAGAMENTO })
  status!: StatusPagamento;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123456789-abc',
    description: 'init_point da preference do Checkout Pro',
  })
  linkPagamento!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '184177738229',
    description:
      'Id do pagamento no Mercado Pago que confirmou ou recusou a cobrança; nulo enquanto aguarda',
  })
  pagamentoExternoId!: string | null;

  @ApiProperty({ example: '2026-10-27T10:00:00.000Z' })
  criadoEm!: Date;

  @ApiProperty({ example: '2026-10-27T11:00:00.000Z' })
  atualizadoEm!: Date;

  static fromDomain(pagamento: Pagamento): PagamentoResponseDto {
    return {
      id: pagamento.getId(),
      ordemServicoId: pagamento.getOrdemServicoId(),
      valor: pagamento.getValor(),
      status: pagamento.getStatus(),
      linkPagamento: pagamento.getLinkPagamento(),
      pagamentoExternoId: pagamento.getPagamentoExternoId(),
      criadoEm: pagamento.getCriadoEm(),
      atualizadoEm: pagamento.getAtualizadoEm(),
    };
  }
}
