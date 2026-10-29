import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../../auth/decorators/roles.decorator';
import { Role } from '../../../../auth/enums/role.enum';
import { ConsultarPagamentoUseCase } from '../../application/use-cases/consultar-pagamento.use-case';
import { PagamentoResponseDto } from '../dto/pagamento-response.dto';

@Controller('pagamentos')
@ApiTags('Pagamentos')
export class PagamentoController {
  constructor(
    @Inject(ConsultarPagamentoUseCase)
    private readonly consultarPagamentoUseCase: ConsultarPagamentoUseCase
  ) {}

  // Staff, como a consulta do orçamento: o Billing não guarda o dono da OS, então não há como
  // restringir um CLIENTE ao próprio pagamento.
  @Get(':ordemServicoId')
  @Roles(Role.ADMIN, Role.RECEPCIONISTA)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Consultar o status do pagamento da OS' })
  @ApiResponse({ status: 200, type: PagamentoResponseDto })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({ status: 403, description: 'Permissões insuficientes' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado para a OS' })
  async consultar(
    @Param('ordemServicoId', ParseUUIDPipe) ordemServicoId: string
  ): Promise<PagamentoResponseDto> {
    const pagamento = await this.consultarPagamentoUseCase.execute(ordemServicoId);
    return PagamentoResponseDto.fromDomain(pagamento);
  }
}
