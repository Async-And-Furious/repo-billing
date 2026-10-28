-- Aditiva (#325): id do pagamento no Mercado Pago e idempotencia de entrada do webhook.

-- AlterTable
ALTER TABLE "pagamentos" ADD COLUMN "mercado_pago_payment_id" TEXT;

-- CreateTable
CREATE TABLE "webhook_recebido" (
    "id" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "recebido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_recebido_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pagamentos_mercado_pago_payment_id_key" ON "pagamentos"("mercado_pago_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_recebido_provider_event_id_tipo_key" ON "webhook_recebido"("provider_event_id", "tipo");
