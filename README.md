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

## Visão do serviço e fatia de domínio

```mermaid
flowchart LR
  Cliente["Cliente / Recepção"] -->|"Bearer JWT (aprovar/recusar é público, ADR-0011)"| GW["Gateway + ALB interno"]
  MP["Mercado Pago"] -->|"webhook com x-signature"| GW
  GW -->|"/api/v1/orcamentos*, /pagamentos*, /webhooks/mercado-pago"| B["Billing API"]
  B -->|"Prisma"| DB[("PostgreSQL: billing")]
  B -->|"preference, reconsulta e estorno"| MP
  OS["OS Service"] -->|"OrcamentoCalculado (#326)"| K[("Kafka")]
  K --> B
  B -->|"OrcamentoAprovado, PagamentoConfirmado... (#326)"| K
```

**Justificativa da fatia.** O Billing é dono do que muda de estado por causa do dinheiro: o `Orcamento` (migrado do OS Service pelo Epic #306) e o `Pagamento` (extraído do `financeiro` do monólito). Isso isola a integração com o Mercado Pago, as credenciais de cobrança e o ciclo de estorno do resto da OS. A fronteira é explícita: o Billing recebe os totais prontos do OS Service por evento e não consulta as tabelas dele; nenhuma FK cruza o banco. A comunicação é por eventos (coreografia), sem chamada REST para o OS Service.

**Swagger:** `/api/docs/billing` (JSON em `docs/openapi.json`, regenerado com `pnpm openapi:export`).

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

Qualidade: `pnpm exec eslint "{src,test}/**/*.ts"` (sem `--fix`; `pnpm lint` corrige arquivos), `pnpm type:check`, `pnpm test:cov` (gate de 80/80/80/80 no `jest.config.js`, igual ao OS Service) e `pnpm build`. O job `tests` da esteira roda o mesmo conjunto.

## Esteira de CI/CD (#327)

Dois workflows em `.github/workflows/`, independentes de qualquer outro serviço. Node 22 é o requisito declarado em `.nvmrc`, `package.json` (`engines`), `Dockerfile` (`node:22-slim`) e nos workflows, que leem `.nvmrc`.

### `ci.yml`: checks obrigatórios da `main`

Roda em PR e em push para `main`. Os três jobs são os checks de proteção de branch (`tests`, `sonar` e `trivy`).

> **ATENÇÃO: a proteção da `main` precisa mudar junto com este merge, ou todo PR fica bloqueado.**
> A proteção atual exige o check `validate`, uma aprovação e `enforce_admins` (ninguém passa por cima). Este PR não tem mais o `validate` antigo, mas mantém um job `validate` **de transição**, que passa só quando `tests` passa. Ordem:
>
> 1. **Este PR:** o `validate` de transição roda no próprio PR e o libera enquanto a proteção ainda o exige. Não é preciso mexer na proteção para este merge.
> 2. **Depois do merge** (Settings > Branches, regra da `main`): trocar os required checks de `validate` para `tests`, `sonar` e `trivy`. Antes disso, o `SONAR_TOKEN` e o projeto `Async-And-Furious_repo-billing` no SonarCloud precisam existir, senão o `sonar` falha em todo PR e a `main` trava.
> 3. **PR seguinte:** remover o job `validate` de `ci.yml`.
>
> Antes do merge, o environment `hml` precisa ter os secrets e variáveis da seção abaixo, e `SONAR_TOKEN` precisa existir. O push em `main` dispara `deploy-eks.yml` e o `sonar`: sem eles, os runs falham depois do merge (o `infra.sh` aborta, por exemplo com `MP_ACCESS_TOKEN ausente`), e o HML fica sem a versão.

| Check | O que faz | Bloqueia? |
|---|---|---|
| `tests` | `prisma generate`, lint, `pnpm type:check`, `pnpm test:cov` (gate 80/80/80/80 do `jest.config.js`) e `pnpm build`. Publica `coverage/lcov.info` como artifact | Sim, em PR e em `main` |
| `sonar` | Análise no SonarCloud com o lcov do job `tests` (`sonar-project.properties`) | Quality Gate bloqueante só no push em `main`; em PR a análise é informativa |
| `trivy` | Build da imagem e scan de HIGH/CRITICAL (tabela e SARIF) | O relatório sempre sai. O gate final é informativo, igual ao template do monólito (ver pendências) |
| `validate` (transição) | Falha se `tests` não terminou com `success`. Usa `if: always()` para que um `tests` falho não vire check pulado (pulado conta como aprovado) | Só enquanto a proteção ainda o exigir; depois sai do `ci.yml` |

O job `sonar` não roda em PR de fork, porque o fork não recebe o `SONAR_TOKEN`. Como check obrigatório, o job pulado conta como aprovado: nesse caso o Quality Gate não bloqueia. Se o grupo quiser outra regra, é decisão dele.

### `deploy-eks.yml`: deploy HML isolado

Dispara em push para `main` que altere `src/`, `prisma/`, `k8s/`, `scripts/deploy/`, `Dockerfile`, dependências ou o próprio workflow, e também manualmente (`workflow_dispatch`, só quando a branch selecionada é a `main`; em outra branch os jobs são pulados). Não há deploy de produção neste repositório.

1. **`image`** (environment `hml`): faz o build e o push para o ECR `tc3-billing-hml`, com tag = SHA do commit. O nome do repositório vem do state do `repo-k8s-infra`. O ECR é imutável: se a tag do SHA já existe (re-run), o job reaproveita a imagem. A referência usada no deploy é `repositório@sha256:<digest>`.
2. **`deploy-hml`** (environment `hml`, depende de `image`):
   - resolve cluster, target group do Billing e banco (`scripts/deploy/infra.sh infra`), pelos states do `repo-k8s-infra` e do `repo-db-infra`;
   - lê os segredos de runtime (`scripts/deploy/infra.sh segredos`): senha do banco no secret `tc3-db-billing-hml`, senha do Kafka em `tc3/kafka/hml` e chave pública JWT no SSM;
   - libera temporariamente o IP do runner no endpoint do EKS (o endpoint é privado) e devolve a configuração original num step `if: always()`;
   - verifica se o cluster está `ACTIVE` e se o namespace `billing` existe. O namespace não é criado aqui: é do `repo-k8s-infra` (ADR-0020 deste repositório de infra, não a do monólito);
   - renderiza `k8s/` e aplica ConfigMap e Secret;
   - **migration antes do rollout**: apaga o `billing-migrate` anterior, aplica o Job (`prisma migrate deploy`) e espera completar;
   - seed de demonstração só se `seed_hml` estiver marcado no disparo manual (idempotente, `DEPLOY_ENV=hml`);
   - aplica Deployment, Service, TargetGroupBinding e HPA e espera o `rollout status`.

### Placeholders e renderização

`k8s/` guarda placeholders `${nome}`, sem valor real no Git. `scripts/deploy/render-k8s.mjs` preenche cada `${nome}` com a variável de ambiente `NOME` (em maiúscula), como string JSON, que é YAML válido, então PEM e senhas com caracteres especiais não quebram o arquivo. Se o manifesto referencia uma variável vazia ou ausente, o deploy para antes de aplicar qualquer coisa. O padrão de placeholders segue a ADR-0015 (`templatefile()` no Terraform); o renderizador é deste repositório.

O `secret.yaml` passa a referenciar `${mp_webhook_secret}` com o merge do repo-billing#1 (#325); antes dele, `MP_WEBHOOK_SECRET` não é exigida. Depois dele, a variável é obrigatória e o deploy para com a lista do que falta. `MP_PREFERENCE_EXPIRACAO_HORAS` é literal `'48'` no configmap (#325), não placeholder, então o pipeline não a preenche.

O `replicas` do Deployment é literal (`2`), e não placeholder, porque o renderer põe valores entre aspas e o campo precisa ser inteiro.

## Secrets e variáveis (GitHub Environment `hml`)

Cadastre tudo no environment `hml` (Settings > Environments), e não no repositório, para que a proteção do environment valha. O `SONAR_TOKEN` é a exceção: é um secret de repositório, porque o job `sonar` não usa environment.

| Nome | Tipo | Origem | Usado em |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret | credencial IAM de deploy do grupo (não pessoal) | `image`, `deploy-hml` |
| `MP_ACCESS_TOKEN` | secret | painel do Mercado Pago, aba **Teste** (ADR-0022, ainda em Proposta) | `billing-secret` |
| `MP_WEBHOOK_SECRET` | secret | chave de assinatura dos webhooks do Mercado Pago. Precisa ser a que assina as notificações **reais** (ver `.env.example`) | `billing-secret`, a partir do merge do #325 |
| `JWT_PUBLIC_KEY_PARAMETER_NAME` | variável | nome do parâmetro SSM com a chave pública RS256 (a mesma usada pelo monólito) | `billing-secret` |
| `MP_NOTIFICATION_URL` | variável | URL pública do webhook pelo Gateway: `https://<gateway>/api/v1/webhooks/mercado-pago` | `billing-config` (obrigatória) |
| `KAFKA_BROKERS` | variável, opcional | padrão `kafka.kafka.svc.cluster.local:9092` (repo-k8s-infra) | `billing-config` |
| `KAFKA_SASL_USERNAME` | variável, opcional | padrão `app` (usuário do `kafka-values.yaml`) | `billing-secret` |
| `AWS_REGION` | variável, opcional | padrão `us-east-1` | todos os jobs |
| `SONAR_TOKEN` | secret de repositório | SonarCloud (organização `async-and-furious`) | `sonar` |

Não são GitHub secrets, de propósito: a senha do banco vem do Secrets Manager (`tc3-db-billing-hml`), a senha do Kafka vem do Secrets Manager (`tc3/kafka/hml`) e o state é lido do S3. Assim não há cópia manual que possa ficar desatualizada.

## Gate de cobertura de 80%: como provar

O `jest.config.js` tem `coverageThreshold` de 80 em statements, branches, functions e lines. O job `tests` roda `pnpm test:cov`, então o gate é avaliado no CI. O monólito não tem isso (o `tests.yml` roda `pnpm test` sem cobertura).

**Local (28/10/2026, baseline):** 21 suítes e 129 testes passam. Cobertura: 99,09% statements, 90,05% branches, 99,05% functions e 99,03% lines.

**Prova de que reprova** (sem alterar nenhum arquivo: a flag de CLI remove os testes do módulo `financeiro`):

```bash
pnpm exec jest --coverage --testPathIgnorePatterns='/node_modules/|/dist/|src/modules/financeiro/'
```

Resultado: exit code 1, com `Jest: "global" coverage threshold for statements (80%) not met: 21.75%` (e os demais critérios), e a linha final de cobertura de 21,75% statements, 55,61% branches, 16,14% functions e 21,06% lines. Como nada foi alterado no repositório, não há o que reverter.

**Prova no GitHub** (depende de você, porque exige push):

1. Crie uma branch de teste a partir da `main` e, nela, remova ou desative os specs de `src/modules/financeiro/` (por exemplo, renomeie os arquivos para fora do padrão `*.spec.ts`).
2. Abra um PR de teste e espere o check `tests` ficar vermelho, com a mensagem de threshold no log.
3. Copie o link do run e o link do PR para o card #327 (critério de aceite).
4. Feche o PR sem merge e apague a branch.

## Testes e BDD

Os testes são unitários, com Jest, dentro de `src/` (`*.spec.ts`). Não há framework BDD neste repositório: o requisito de "pelo menos um fluxo completo testado com BDD" (enunciado, p.4) fica com o épico de Saga do OS Service, que representa o fluxo de ponta a ponta. Dependência a acompanhar: se o épico escorregar, o BDD não é entregue.

## Kubernetes

Manifestos em `k8s/`, aplicados pelo pipeline (exceto onde indicado):

| Arquivo | Recurso | Observação |
|---|---|---|
| `configmap.yaml` | `billing-config` | variáveis não sensíveis; `KAFKA_BROKERS` e `MP_NOTIFICATION_URL` são placeholders |
| `secret.yaml` | `billing-secret` | `DATABASE_URL`, `JWT_PUBLIC_KEY`, Kafka e Mercado Pago são placeholders |
| `deployment.yaml` | `billing-api` | 2 réplicas; probes em `/api/v1/health/*`; limites de CPU e memória |
| `service.yaml` | `billing-service` | ClusterIP 3000 |
| `target-group-binding.yaml` | `billing-api` | registra os pods no target group do Billing do ALB interno (`TARGET_GROUP_ARN`) |
| `hpa.yaml` | `billing-hpa` | 2 a 3 réplicas por CPU e memória |
| `migration-job.yaml` | `billing-migrate` | `prisma migrate deploy`, roda antes do rollout |
| `seed-job-hml.yaml` | `billing-seed-hml` | seed de demonstração, só com `seed_hml` no disparo manual |

O namespace `billing` e o ECR `tc3-billing-hml` são criados pelo `repo-k8s-infra`. Não há manifesto de namespace neste repositório.

## Pendências da esteira (#327)

**Neste repositório (esta issue):**

- Proteção da `main` no GitHub: PR obrigatório, uma aprovação, e os checks `tests`, `sonar` e `trivy`. Passos e ordem na seção "Esteira" (atenção sobre o `validate` de transição). Em `develop`, a regra da issue não se aplica: este repositório só tem `main`.
- Projeto `Async-And-Furious_repo-billing` no SonarCloud (organização `async-and-furious`), com o `SONAR_TOKEN` cadastrado. A chave do projeto está em `sonar-project.properties`.
- Trivy: o gate final de HIGH/CRITICAL está informativo, igual ao monólito. Para bloquear, basta remover `continue-on-error` do último step. Decisão do grupo; a ADR-0013 do `async-furious-project` registra esse risco.
- Prova do gate de 80% no GitHub (seção acima) e print do Quality Gate no SonarCloud.
- Deploy real em HML: não foi executado (sem acesso a AWS nem kubectl neste ambiente).
- Evidência de cobertura para o critério da issue: link do run verde do job `tests` na `main` (ou print do Sonar) colado aqui depois do primeiro run.
- Swagger com a rota de webhook e as de pagamento: `docs/openapi.json` da `main` ainda não tem `GET /api/v1/pagamentos/{ordemServicoId}` nem a descrição de assinatura do webhook. Isso chega com o merge do repo-billing#1 (#325), que regenera o arquivo.

**Fora deste repositório (não alterado por esta issue):**

- `repo-k8s-infra` (develop já tem ECR `tc3-billing-*`, namespace `billing`, target group e regras de path do Billing, e Kafka em `kafka.kafka.svc.cluster.local:9092`): confirmar que o `up.yml` foi aplicado em HML e que o state tem `service_target_group_arns.billing` e `ecr_repository_names.billing`.
- `repo-db-infra` (develop já tem `db_billing_secret_arn` e `db_billing_name`): confirmar a aplicação em HML. O banco `billing` e a role `billing_app` são criados pelo bootstrap do monólito, que precisa rodar depois do deploy do OS Service.
- `async-furious-project` (#317): rota do Billing no API Gateway. `POST /api/v1/webhooks/mercado-pago` precisa ficar **sem** authorizer. Sem ela, `MP_NOTIFICATION_URL` não chega ao serviço.
- `repo-billing` PR #1 (#325): entra antes deste PR. A partir dele, `MP_WEBHOOK_SECRET` é obrigatória no environment `hml`; sem ela, o `render-k8s.mjs` para o deploy antes de aplicar qualquer manifesto.
- SonarCloud: criação do projeto e do token (ver acima).

## Pendências conhecidas

- Migration e seed da #324 ainda não foram aplicados em HML: dependem do banco `billing` (abaixo) e do pipeline de deploy (#327).
- Publicação e consumo de eventos no Kafka (`OrcamentoCalculado` → `GerarOrcamentoHandler`, `OrcamentoGerado`/`OrcamentoAprovado`/`OrcamentoRecusado` em `billing.eventos.v1`) entram na #326.
- Webhook do Mercado Pago e confirmação/recusa do pagamento entram na #325; a criação da preference na aprovação já está aqui.

- Banco `billing`/role `billing_app` e o teste de acesso cruzado só podem ser validados em HML, após o `repo-db-infra` PR #31 e o Job de bootstrap.
- Divergência do template, herdada do `repo-execucao-service`: o `jwt.config.ts` foi reduzido a verificação (sem assinatura).
- O workflow de CI não é cópia do OS Service: o template da #333 ainda não foi publicado.
