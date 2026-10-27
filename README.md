# repo-billing-service

Billing Service (Orçamento e Pagamento) do Tech Challenge Fase 4 (FIAP SOAT). Feature #323 do repositório `async-furious-project`, dentro do Epic #322.

Stack: NestJS 10, Prisma 5, PostgreSQL, Node 22, pnpm. Quatro camadas por módulo (`domain`, `application`, `infrastructure`, `presentation`) mais `shared/` (ADR-0006).

## Origem

Scaffold **copiado** do OS Service, pela mesma cópia já feita no `repo-execucao-service` (#319): sem fork, sem pacote npm compartilhado e sem submódulo git. Só foram ajustados nome do serviço, namespace (`billing`), banco e Swagger. O módulo `src/modules/financeiro/` é dono dos domínios `Orcamento` (migrado do `ordem-servico` por decisão do Epic #306) e `Pagamento` (extraído do `financeiro` do monolito), implantados na Feature #324. `ProcessedEvent` guarda a idempotência dos eventos Kafka por `eventId`.

## Domínio (Feature #324)

| Agregado | Ciclo de vida |
|---|---|
| `Orcamento` | `PENDING → APPROVED \| REJECTED` (enum `EstimateStatus`, o mesmo do monolito) |
| `Pagamento` | `AGUARDANDO_PAGAMENTO → CONFIRMADO \| RECUSADO \| CANCELADO`; `CONFIRMADO → ESTORNADO` (enum `StatusPagamento`) |

- **Totais vêm prontos do OS Service.** O `GerarOrcamentoHandler` monta o orçamento só com `valorTotalServicos`, `valorTotalPecas` e `valorTotalGeral` do evento `OrcamentoCalculado`, grava os três como vieram (sem recalcular nem conferir a soma) e não consulta `Peca`, `Servico`, `OsPeca` nem `OsServico`, nem chama o OS Service por REST. Um `OrcamentoCalculado` repetido com o orçamento ainda `PENDING` atualiza os totais; depois da aprovação ou recusa, é ignorado sem erro (ADR-0018).
- **Aprovação** (`PATCH /orcamentos/{ordemServicoId}/aprovar`): valida `PENDING`, cria a preference do Checkout Pro (um item agregado `OS {id}` com valor = `valorTotalGeral`, sem `payer`), grava numa transação `Orcamento=APPROVED` + `Pagamento=AGUARDANDO_PAGAMENTO` (com `preferenceId` e `linkPagamento`), publica `OrcamentoAprovado` após o commit e devolve `{ linkPagamento }`. Aprovar de novo devolve o mesmo link sem republicar; aprovar depois de `REJECTED` é erro de domínio (400); falha do Mercado Pago devolve 502 e o orçamento segue `PENDING`.
- **Compensação da saga**: `CANCELADO` quando a saga falha antes do pagamento, `ESTORNADO` após o refund. O estorno não gera evento de integração; a evidência é `Pagamento.status = ESTORNADO` mais o refund no painel do Mercado Pago.
- **Eventos**: por enquanto o publicador (`LogPublicadorEventos`) só registra `OrcamentoGerado`, `OrcamentoAprovado` e `OrcamentoRecusado` em log. O produtor/consumidor Kafka entra na Feature de eventos (#326), trocando só o adapter da porta `IPublicadorEventos`.

## Banco de dados

PostgreSQL, banco `billing`, role `billing_app` na instância RDS única, com `connection_limit=3` no `DATABASE_URL` (ADR-0020).

Tabelas: `orcamentos`, `pagamentos` e `processed_events`. **Nenhuma FK cruza a fronteira de serviço**: `Orcamento` e `Pagamento` referenciam a OS só por `ordemServicoId` (`@unique` nos dois). No monolito, `Orcamento` tinha FK para `OrdemServico` com `onDelete: Cascade`; ela foi removida porque a OS vive no banco do OS Service, e o Billing não pode ter constraint para lá. O fim de uma OS chega por evento, não por cascade: o orçamento e o pagamento ficam como registro auditável. O `@unique` em `Pagamento.ordemServicoId` garante uma cobrança por OS (um 2º pagamento da mesma OS viola a constraint e a aprovação concorrente perde).

**Migrations** versionadas em `prisma/migrations/`, aplicadas por `prisma migrate deploy` no `billing-migrate` (`k8s/migration-job.yaml`). O serviço começa vazio: não há ETL do monolito (decisão do Epic #306).

**Seed de demonstração** (`prisma/seed.mjs`, `pnpm db:seed`): cria um orçamento `PENDING` e um orçamento `APPROVED` com pagamento `AGUARDANDO_PAGAMENTO`, idempotente. Só roda com `DEPLOY_ENV=local` ou `hml` e recusa qualquer outro valor. Em HML, roda pelo `k8s/seed-job-hml.yaml` depois do `billing-migrate`; o manifesto não deve ser aplicado em produção. O secret `tc3-db-billing-<env>` é provisionado pelo `repo-db-infra` (Epic #312) e o banco/role são criados pelo `Job` de bootstrap do OS Service (#315), que também revoga o acesso do Billing aos bancos dos outros serviços. O serviço não acessa tabelas de outro serviço.

**Sem NoSQL.** O read model em DocumentDB fica no OS Service (#306); o Billing não depende de driver `mongodb`.

## Estratégia de Saga

**Coreografada** (ADR-0016, `docs/architecture/saga-flow.md` no `async-furious-project`). O Billing não recebe comandos: reage a eventos do Kafka e publica os seus em `billing.eventos.v1`. Consumidores e produtores entram na Feature #326; aqui só estão as variáveis `KAFKA_*` no configmap/secret.

## Autenticação

`src/auth/` é a variante stateless do JWT local (ADR-0021): `JwtStrategy` valida localmente e devolve `{ id: sub, email, role }`, sem Prisma e sem `AuthService`. `JwtAuthGuard` e `RolesGuard` são globais (`APP_GUARD`). Token sem `role` vira `Role.CLIENTE` e recebe 403 em rota com `@Roles`; role fora do enum é rejeitada com 401. O Lambda Authorizer continua validando primeiro, na borda.

### Rotas públicas

| Rota | Motivo |
|---|---|
| `PATCH /api/v1/orcamentos/{ordemServicoId}/aprovar` | ADR-0011 |
| `PATCH /api/v1/orcamentos/{ordemServicoId}/recusar` | ADR-0011 |
| `POST /api/v1/webhooks/mercado-pago` | o provedor não apresenta nosso JWT; a autenticação é a assinatura `x-signature` (#325) |

**Risco aberto (ADR-0011, revisada em 30/09/2026):** as rotas de aprovação/recusa mudaram de serviço (OS Service → Billing) e de path (`/ordens-servico/:id/orcamento/*` → `/orcamentos/{ordemServicoId}/*`), sem rota de proxy no OS Service, e seguem públicas. Elas não identificam o cliente: qualquer pessoa com o id da OS pode aprová-la ou recusá-la, e agora a aprovação gera cobrança no Mercado Pago. O risco segue **aberto** e não é fechado aqui: link assinado fica fora da Fase 4. Ver [`docs/adr/0011-aprovacao-orcamento-api-publica.md`](https://github.com/Async-And-Furious/async-furious-project/blob/develop/docs/adr/0011-aprovacao-orcamento-api-publica.md) no `async-furious-project`.

## API (OpenAPI)

Swagger em `/api/docs/billing`. O contrato versionado fica em [`docs/openapi.json`](docs/openapi.json), regenerado com `pnpm openapi:export` (não precisa de banco).

| Método | Rota | Autenticação | Situação |
|---|---|---|---|
| `GET` | `/api/v1/orcamentos/{ordemServicoId}` | Bearer, `ADMIN`/`RECEPCIONISTA` | implementada (#324) |
| `PATCH` | `/api/v1/orcamentos/{ordemServicoId}/aprovar` | pública (ADR-0011) | implementada (#324); devolve `{ linkPagamento }` |
| `PATCH` | `/api/v1/orcamentos/{ordemServicoId}/recusar` | pública (ADR-0011) | implementada (#324) |
| `POST` | `/api/v1/webhooks/mercado-pago` | pública | 501 até a #325 |
| `GET` | `/api/v1/health`, `/health/live`, `/health/ready` | pública | implementada |

## Rodando localmente

```bash
cp .env.example .env
docker compose -f docker-compose.dependencies.yml up -d
pnpm install
pnpm exec prisma migrate deploy
pnpm db:seed   # opcional: dados de demonstração
pnpm start
```

A aprovação de orçamento chama o Mercado Pago: configure `MP_ACCESS_TOKEN` (credencial de teste) e, se quiser receber o webhook, `MP_NOTIFICATION_URL`. No Kubernetes, `MP_ACCESS_TOKEN` fica no `billing-secret` e `MP_NOTIFICATION_URL` no `billing-config`.

Qualidade: `pnpm lint`, `pnpm type:check`, `pnpm test:cov` (gate de 80/80/80/80 no `jest.config.js`, igual ao OS Service) e `pnpm build`.

## Kubernetes

Manifestos em `k8s/`: namespace `billing`, Deployment, Service, migration Job, configmap e secret. O secret é um template (`${database_url}` etc.) preenchido pelo pipeline a partir do Secrets Manager (ADR-0015); nenhuma credencial é versionada. Namespace e ECR próprios são provisionados pelo Epic #312.

## CI

`.github/workflows/ci.yml` roda lint, typecheck, testes com cobertura e build em todo PR; a `main` exige PR, uma aprovação e o check `validate`. Sonar, build de imagem e deploy entram na Feature de testes e pipeline (#327), copiados do template do OS Service (#333).

## Pendências conhecidas

- Migration e seed da #324 ainda não foram aplicados em HML: dependem do banco `billing` (abaixo) e do pipeline de deploy (#327).
- Publicação e consumo de eventos no Kafka (`OrcamentoCalculado` → `GerarOrcamentoHandler`, `OrcamentoGerado`/`OrcamentoAprovado`/`OrcamentoRecusado` em `billing.eventos.v1`) entram na #326.
- Webhook do Mercado Pago e confirmação/recusa do pagamento entram na #325; a criação da preference na aprovação já está aqui.

- Banco `billing`/role `billing_app` e o teste de acesso cruzado só podem ser validados em HML, após o `repo-db-infra` PR #31 e o Job de bootstrap.
- Divergência do template, herdada do `repo-execucao-service`: o `jwt.config.ts` foi reduzido a verificação (sem assinatura).
- O workflow de CI não é cópia do OS Service: o template da #333 ainda não foi publicado.
