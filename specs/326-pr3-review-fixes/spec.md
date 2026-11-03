# PR #3 review fixes — issue #326

Scope is restricted to `repo-billing` PR #3. Live head was `8d9dfc9101460d61e921179ea574164c238a15aa`; live base `feat/I-327_PipelineDeployIndependenteBilling` was `ed48c31c46581757f2cb56013ae55f3f975cbdf6` and is already an ancestor of the head. No rebase/merge is needed.

| Review/contract item | Required behavior | Test / code location |
|---|---|---|
| Inline retry exceeds KafkaJS session timeout | Heartbeat during retry wait without acknowledging/committing before retry or confirmed retry-DLT publish | `test/kafka-consumidor-eventos.spec.ts`; `src/modules/financeiro/infrastructure/messaging/kafka-consumidor-eventos.ts` |
| Invalid poison envelopes | Send once to DLT, log and ignore; a failed DLT send must propagate and not lose the offset | Same test and consumer |
| Saga failure DLT | Log explicit pending compensation with safe identifiers/error; no success/failure event; replay via normal processing | Same test and consumer; preserve ADR-0018 DLT mapping and fromBeginning behavior |
| New Relic SagaStep | Emit custom event per accepted contract using existing dependency only | consumer tests; consumer implementation |
| Compensation replay | Refund success followed by DB error then replay with same Mercado Pago idempotency key | `test/compensar-falha-saga.spec.ts`; handler and repositories |
| Payment-absent saga failure | Explicit user consent received: atomically close a PENDING budget in its existing row. Approval competes on the same conditional status update; if approval wins, reread Payment and compensate it. On Mercado Pago rollback, never reopen a budget if the payment was cancelled and never delete a cancelled payment. Tests cover approval race/late approval, rollback and retry refund. |

Do not add Kafka event types, outbox/ProcessedEvent usage, credentials, infrastructure, or change public API. Do not relax CI gates. Focused tests first (RED then GREEN), followed by focused lint (without autofix), typecheck, and build. Full suite is deferred to parent reconciliation. Payment-absent closure reuses the existing REJECTED state; no sentinel, new table or schema state is introduced.
