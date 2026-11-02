# Billing Service — arquitetura

Billing é o serviço dono do orçamento financeiro e do pagamento da Ordem de
Serviço (OS). Recebe do OS Service os valores já calculados, persiste o
orçamento e conduz aprovação, cobrança e atualização do pagamento. Não calcula
totais, não lê dados do banco do OS Service e não altera o status da OS.

## API REST

A API usa o prefixo `/api/v1`; a interface Swagger é servida em
`/api/docs/billing`.

| Método e rota | Acesso | Função |
|---|---|---|
| `GET /api/v1/orcamentos/{ordemServicoId}` | JWT; `ADMIN` ou `RECEPCIONISTA` | Consulta o orçamento da OS. |
| `PATCH /api/v1/orcamentos/{ordemServicoId}/aprovar` | Pública | Aprova o orçamento, cria uma preference do Checkout Pro e retorna `{ linkPagamento }`. |
| `PATCH /api/v1/orcamentos/{ordemServicoId}/recusar` | Pública | Recusa o orçamento. |
| `GET /api/v1/pagamentos/{ordemServicoId}` | JWT; `ADMIN` ou `RECEPCIONISTA` | Consulta o pagamento da OS. |
| `POST /api/v1/webhooks/mercado-pago` | Pública; assinatura HMAC obrigatória | Recebe notificação e reconsulta o pagamento no Mercado Pago. |
| `GET /api/v1/health`, `/api/v1/health/live`, `/api/v1/health/ready` | Pública | Health checks. |

As rotas públicas de aprovar/recusar não identificam o cliente: qualquer
pessoa com o id da OS pode chamá-las. Esse risco está registrado na
[ADR-0011](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0011-aprovacao-orcamento-api-publica.md).
O webhook valida `x-signature`/`x-request-id` antes de qualquer efeito; a
notificação é um gatilho, e o estado é obtido pela API do Mercado Pago.

## Eventos de integração e Saga

Billing publica em `billing.eventos.v1`:
`OrcamentoGerado`, `OrcamentoAprovado`, `OrcamentoRecusado`,
`PagamentoConfirmado`, `PagamentoRecusado` e `EtapaDaSagaFalhou` (publicado
em `billing.eventos.v1` quando uma falha irrecuperável de domínio em
`OrcamentoCalculado` ou sua mensagem na DLT requer sinalizar
`etapa=orcamento`). Consome `OrcamentoCalculado` de `os.eventos.v1` e
`EtapaDaSagaFalhou` de `os.eventos.v1` e
`execucao.eventos.v1`, além dos
tópicos próprios `billing.retry.v1` e `billing.dlt.v1`. O consumer group é
`billing-consumer`. O envelope usa `correlationId = ordemServicoId`, e a
chave Kafka é o id da OS. Em caso de falha técnica, há até três tentativas;
o Billing publica `EtapaDaSagaFalhou` após falha de domínio irrecuperável no
cálculo/geração do orçamento ou ao processar a DLT de `OrcamentoCalculado`.

Na compensação, `EtapaDaSagaFalhou` só afeta as etapas
`aprovacao-pagamento` e `inicio-execucao`: pagamento pendente é cancelado;
pagamento confirmado é estornado idempotentemente e marcado `ESTORNADO`.
Não há evento Kafka de estorno, nem alteração do status da OS pelo Billing.
O consumer usa guardas de estado, não a tabela `ProcessedEvent` herdada do
schema (ela permanece sem uso pelo consumer).

Veja o [catálogo de eventos](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/architecture/event-catalog.md),
a [ADR-0018 — contrato de mensageria](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0018-mensageria-contratos-eventos.md)
e o [fluxo completo da Saga](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/architecture/saga-flow.md).

## Dados e ownership

O Billing possui PostgreSQL próprio (banco lógico `billing`, role
`billing_app`). Não há foreign keys para dados de outros serviços: a OS é
referenciada apenas por `ordemServicoId`.

| Modelo/tabela | Responsabilidade |
|---|---|
| `Orcamento` / `orcamentos` | Valores de serviços, peças e total recebidos do OS Service, além do estado `PENDING`, `APPROVED` ou `REJECTED`; uma linha por OS. |
| `Pagamento` / `pagamentos` | Valor e estado da cobrança, preference/link do Checkout Pro e id do pagamento externo; uma cobrança por OS. |
| `WebhookRecebido` / `webhook_recebido` | Deduplicação de notificações do provedor, com unicidade por id do evento externo e tipo. |
| `ProcessedEvent` / `processed_events` | Modelo legado do schema; mantido, mas não utilizado pelo consumer Kafka atual. |

O Billing não usa DocumentDB/NoSQL. As migrations são versionadas em
`prisma/migrations/` e aplicadas com `prisma migrate deploy`.

## Dependências e limites

- **Kafka:** transporte assíncrono dos contratos acima, via KafkaJS; produtor
  idempotente com `acks=all`. Não existe outbox, portanto há risco de perda
  entre commit local e publicação. O detector do OS Service só cobre
  `AWAITING_APPROVAL` com `pago_em` nulo; uma redelivery do webhook após o
  commit é reconhecida como processada e não republica o evento.
- **Mercado Pago:** Checkout Pro cria a cobrança; webhook assinado dispara a
  reconsulta do pagamento; o Billing também solicita refund nos casos de
  compensação aplicáveis. Credenciais são configuração externa e não devem
  ser versionadas.
- **API Gateway/ALB:** expõe as rotas do serviço pela borda aprovada. As rotas
  de aprovação/recusa e o webhook são públicas; o webhook se autentica por
  HMAC, não por JWT.
- **Persistência:** PostgreSQL do Billing, isolado por credenciais das bases
  dos outros serviços.

## Execução local

Requisitos: Node.js 22+, pnpm e Docker. Configure `.env` a partir de
`.env.example`; ajuste a URL local do PostgreSQL conforme o compose. Para
receber webhooks locais, configure credenciais de teste e uma URL pública de
túnel em `MP_NOTIFICATION_URL`.

```bash
cp .env.example .env
docker compose -f docker-compose.dependencies.yml up -d
pnpm install
pnpm exec prisma migrate deploy
pnpm db:seed   # opcional; apenas DEPLOY_ENV=local ou hml
pnpm start
```

O seed recusa ambientes diferentes de `local` ou `hml`. A aprovação chama o
Mercado Pago, então configure `MP_ACCESS_TOKEN`; para processar notificações,
configure `MP_WEBHOOK_SECRET` e `MP_NOTIFICATION_URL`. Nunca use credenciais
de produção em desenvolvimento.

## Evidências e estado de validação

O repositório inclui OpenAPI exportado, testes automatizados e workflow de
CI/CD. A documentação de README registra testes unitários e validação via
mock; o refund real no sandbox ainda não foi executado. Não há evidência de
deploy/validação em HML nesta documentação: dependências de infraestrutura,
segredos e fluxo ponta a ponta precisam ser confirmados antes de afirmar que
HML funciona. Verifique a issue/execução atual antes de usar este documento
como evidência de implantação.

## ADRs transversais

- [ADR-0016 — Saga coreografada](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0016-saga-coreografada.md) · [ADR-0017 — Divisão de microsserviços e ownership de dados](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0017-divisao-microsservicos-ownership-dados.md) · [ADR-0018 — Mensageria e contratos de eventos](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0018-mensageria-contratos-eventos.md) · [ADR-0019 — DocumentDB read model OS/cliente](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0019-documentdb-read-model-os-cliente.md) · [ADR-0020 — Bancos compartilhados e isolamento por credencial](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0020-bancos-compartilhados-isolamento-credencial.md) · [ADR-0021 — Borda sem BFF](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0021-borda-sem-bff.md).
