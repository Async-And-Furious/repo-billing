import { ApiProperty } from '@nestjs/swagger';
import { StatusOrcamento } from '../../domain/entities/orcamento.entity';
import type { Orcamento } from '../../domain/entities/orcamento.entity';

export class OrcamentoResponseDto {
  @ApiProperty({ example: '9b2d7c1e-4f3a-4e8b-a1c2-3d4e5f6a7b8c' })
  id!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  ordemServicoId!: string;

  @ApiProperty({ example: 450.0 })
  valorTotalServicos!: number;

  @ApiProperty({ example: 320.5 })
  valorTotalPecas!: number;

  @ApiProperty({ example: 770.5 })
  valorTotalGeral!: number;

  @ApiProperty({ enum: StatusOrcamento, example: StatusOrcamento.PENDING })
  status!: StatusOrcamento;

  static fromDomain(orcamento: Orcamento): OrcamentoResponseDto {
    return {
      id: orcamento.getId(),
      ordemServicoId: orcamento.getOrdemServicoId(),
      valorTotalServicos: orcamento.getValorTotalServicos(),
      valorTotalPecas: orcamento.getValorTotalPecas(),
      valorTotalGeral: orcamento.getValorTotalGeral(),
      status: orcamento.getStatus(),
    };
  }
}

export class AprovacaoOrcamentoResponseDto {
  @ApiProperty({
    example: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123456789-abc',
    description: 'init_point da preference do Checkout Pro',
  })
  linkPagamento!: string;
}
