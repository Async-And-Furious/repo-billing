import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Garantias do schema do Billing que não dependem de banco (critérios de aceite da #324).
describe('schema e migrations do Billing', () => {
  const prismaDir = join(__dirname, '../../../../prisma');
  const schema = readFileSync(join(prismaDir, 'schema.prisma'), 'utf8');
  const migrations = readdirSync(join(prismaDir, 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      readFileSync(join(prismaDir, 'migrations', entry.name, 'migration.sql'), 'utf8')
    )
    .join('\n');

  const bloco = (tipo: 'model' | 'enum', nome: string): string => {
    const match = new RegExp(`${tipo} ${nome} \\{([^}]*)\\}`).exec(schema);
    if (!match) throw new Error(`${tipo} ${nome} não encontrado no schema`);
    return match[1];
  };

  it('só tem models do próprio Billing (nada de Peca, Servico, OsPeca, OsServico ou OrdemServico)', () => {
    const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
    expect(models.sort()).toEqual(['Orcamento', 'Pagamento', 'ProcessedEvent', 'WebhookRecebido']);
  });

  it('nenhuma FK: sem @relation no schema nem FOREIGN KEY nas migrations', () => {
    expect(schema).not.toMatch(/@relation/);
    expect(migrations).not.toMatch(/FOREIGN KEY/i);
  });

  it('Orcamento referencia a OS só por id, único', () => {
    expect(bloco('model', 'Orcamento')).toMatch(/ordemServicoId\s+String\s+@unique/);
    expect(migrations).toContain(
      'CREATE UNIQUE INDEX "orcamentos_ordem_servico_id_key" ON "orcamentos"("ordem_servico_id")'
    );
  });

  it('Pagamento.ordemServicoId é único na migration (2º pagamento da mesma OS viola a constraint)', () => {
    expect(bloco('model', 'Pagamento')).toMatch(/ordemServicoId\s+String\s+@unique/);
    expect(migrations).toContain(
      'CREATE UNIQUE INDEX "pagamentos_ordem_servico_id_key" ON "pagamentos"("ordem_servico_id")'
    );
  });

  it('Pagamento guarda preferenceId e linkPagamento', () => {
    const pagamento = bloco('model', 'Pagamento');
    expect(pagamento).toMatch(/preferenceId\s+String\?/);
    expect(pagamento).toMatch(/linkPagamento\s+String\?/);
  });

  it('Pagamento guarda o id do pagamento no Mercado Pago, único', () => {
    expect(bloco('model', 'Pagamento')).toMatch(
      /mercadoPagoPaymentId\s+String\?\s+@unique\s+@map\("mercado_pago_payment_id"\)/
    );
    expect(migrations).toContain(
      'CREATE UNIQUE INDEX "pagamentos_mercado_pago_payment_id_key" ON "pagamentos"("mercado_pago_payment_id")'
    );
  });

  it('webhook_recebido tem unique (providerEventId, tipo) na migration', () => {
    expect(bloco('model', 'WebhookRecebido')).toMatch(/@@unique\(\[providerEventId, tipo\]\)/);
    expect(migrations).toContain('CREATE TABLE "webhook_recebido"');
    expect(migrations).toContain(
      'CREATE UNIQUE INDEX "webhook_recebido_provider_event_id_tipo_key" ON "webhook_recebido"("provider_event_id", "tipo")'
    );
  });

  it('status do pagamento é enum Prisma com os cinco estados', () => {
    expect(bloco('model', 'Pagamento')).toMatch(/status\s+StatusPagamento/);
    expect(bloco('enum', 'StatusPagamento').split(/\s+/).filter(Boolean)).toEqual([
      'AGUARDANDO_PAGAMENTO',
      'CONFIRMADO',
      'RECUSADO',
      'CANCELADO',
      'ESTORNADO',
    ]);
  });

  it('status do orçamento mantém o EstimateStatus do monolito', () => {
    expect(bloco('enum', 'EstimateStatus').split(/\s+/).filter(Boolean)).toEqual([
      'PENDING',
      'APPROVED',
      'REJECTED',
    ]);
  });
});
