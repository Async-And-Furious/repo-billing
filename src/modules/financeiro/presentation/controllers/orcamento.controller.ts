import { Controller, Get, Inject, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../../auth/decorators/public.decorator';
import { Roles } from '../../../../auth/decorators/roles.decorator';
import { Role } from '../../../../auth/enums/role.enum';
import { AprovarOrcamentoUseCase } from '../../application/use-cases/aprovar-orcamento.use-case';
import { ConsultarOrcamentoUseCase } from '../../application/use-cases/consultar-orcamento.use-case';
import { RecusarOrcamentoUseCase } from '../../application/use-cases/recusar-orcamento.use-case';
import { AprovacaoOrcamentoResponseDto, OrcamentoResponseDto } from '../dto/orcamento-response.dto';

const RISCO_ADR_0011 =
  'Rota pública (ADR-0011): não identifica o cliente, qualquer pessoa com o id da OS pode chamá-la. Risco aberto, registrado na ADR-0011.';

// Rotas migradas de /ordens-servico/:id/orcamento/* do OS Service, sem proxy (edge-topology.md).
@Controller('orcamentos')
@ApiTags('Orcamentos')
export class OrcamentoController {
  constructor(
    @Inject(ConsultarOrcamentoUseCase)
    private readonly consultarOrcamentoUseCase: ConsultarOrcamentoUseCase,
    @Inject(AprovarOrcamentoUseCase)
    private readonly aprovarOrcamentoUseCase: AprovarOrcamentoUseCase,
    @Inject(RecusarOrcamentoUseCase)
    private readonly recusarOrcamentoUseCase: RecusarOrcamentoUseCase
  ) {}

  @Get(':ordemServicoId')
  @Roles(Role.ADMIN, Role.RECEPCIONISTA)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Consultar o orçamento vigente da OS' })
  @ApiResponse({ status: 200, type: OrcamentoResponseDto })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({ status: 403, description: 'Permissões insuficientes' })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado para a OS' })
  async consultar(
    @Param('ordemServicoId', ParseUUIDPipe) ordemServicoId: string
  ): Promise<OrcamentoResponseDto> {
    const orcamento = await this.consultarOrcamentoUseCase.execute(ordemServicoId);
    return OrcamentoResponseDto.fromDomain(orcamento);
  }

  @Public()
  @Patch(':ordemServicoId/aprovar')
  @ApiOperation({
    summary: 'Aprovar orçamento (pública, ADR-0011)',
    description: `${RISCO_ADR_0011} Cria a cobrança no Mercado Pago e devolve o link de pagamento; aprovar de novo devolve o mesmo link.`,
  })
  @ApiResponse({ status: 200, type: AprovacaoOrcamentoResponseDto })
  @ApiResponse({ status: 400, description: 'Orçamento recusado ou sem valores definidos' })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado para a OS' })
  @ApiResponse({
    status: 502,
    description: 'Falha no Mercado Pago; o orçamento continua PENDING',
  })
  aprovar(
    @Param('ordemServicoId', ParseUUIDPipe) ordemServicoId: string
  ): Promise<AprovacaoOrcamentoResponseDto> {
    return this.aprovarOrcamentoUseCase.execute(ordemServicoId);
  }

  @Public()
  @Patch(':ordemServicoId/recusar')
  @ApiOperation({ summary: 'Recusar orçamento (pública, ADR-0011)', description: RISCO_ADR_0011 })
  @ApiResponse({ status: 200, type: OrcamentoResponseDto })
  @ApiResponse({ status: 400, description: 'Orçamento não está pendente' })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado para a OS' })
  async recusar(
    @Param('ordemServicoId', ParseUUIDPipe) ordemServicoId: string
  ): Promise<OrcamentoResponseDto> {
    const orcamento = await this.recusarOrcamentoUseCase.execute(ordemServicoId);
    return OrcamentoResponseDto.fromDomain(orcamento);
  }
}
