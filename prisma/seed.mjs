// Seed de demonstração do Billing (Feature #324). Só roda em local ou HML, nunca contra dado real.
// JavaScript puro para rodar na imagem de produção (sem ts-node): node prisma/seed.mjs
// Idempotente: upsert por ordemServicoId. Os ids de OS são fixos para cruzar com o seed do OS Service.
import { PrismaClient } from '@prisma/client';

const AMBIENTES_PERMITIDOS = ['local', 'hml'];
const ambiente = process.env.DEPLOY_ENV ?? 'local';
if (!AMBIENTES_PERMITIDOS.includes(ambiente)) {
  console.error(`Seed do Billing recusado: DEPLOY_ENV=${ambiente} (permitido: local, hml).`);
  process.exit(1);
}

// Orçamento pendente: pronto para aprovar ou recusar na demonstração.
const OS_ORCAMENTO_PENDENTE = '5b0c2e1a-7d3f-4a8e-9c61-2f4b8d0e6a11';
// Orçamento aprovado com pagamento aguardando: link de Checkout Pro fictício.
const OS_PAGAMENTO_AGUARDANDO = '8e4f1c2b-3a5d-4b7e-8f90-1c2d3e4f5a22';

const prisma = new PrismaClient();

async function seed() {
  await prisma.orcamento.upsert({
    where: { ordemServicoId: OS_ORCAMENTO_PENDENTE },
    update: {},
    create: {
      ordemServicoId: OS_ORCAMENTO_PENDENTE,
      valorTotalServicos: '450.00',
      valorTotalPecas: '320.50',
      valorTotalGeral: '770.50',
      status: 'PENDING',
    },
  });

  await prisma.$transaction([
    prisma.orcamento.upsert({
      where: { ordemServicoId: OS_PAGAMENTO_AGUARDANDO },
      update: {},
      create: {
        ordemServicoId: OS_PAGAMENTO_AGUARDANDO,
        valorTotalServicos: '180.00',
        valorTotalPecas: '95.90',
        valorTotalGeral: '275.90',
        status: 'APPROVED',
      },
    }),
    prisma.pagamento.upsert({
      where: { ordemServicoId: OS_PAGAMENTO_AGUARDANDO },
      update: {},
      create: {
        ordemServicoId: OS_PAGAMENTO_AGUARDANDO,
        valor: '275.90',
        status: 'AGUARDANDO_PAGAMENTO',
        preferenceId: 'seed-preference-hml',
        linkPagamento:
          'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=seed-preference-hml',
      },
    }),
  ]);

  console.log(
    `Seed do Billing (${ambiente}): orçamento pendente da OS ${OS_ORCAMENTO_PENDENTE}, ` +
      `pagamento aguardando da OS ${OS_PAGAMENTO_AGUARDANDO}.`
  );
}

seed()
  .catch((error) => {
    console.error('Falha no seed do Billing:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
