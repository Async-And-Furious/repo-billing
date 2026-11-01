export class EtapaDaSagaFalhou {
  readonly eventType = 'EtapaDaSagaFalhou';

  constructor(
    readonly ordemServicoId: string,
    readonly servicoOrigem: string,
    readonly eventTypeOriginal: string | null,
    readonly etapa: string,
    readonly motivo: string
  ) {}
}
