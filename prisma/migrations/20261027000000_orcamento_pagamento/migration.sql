-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StatusPagamento" AS ENUM ('AGUARDANDO_PAGAMENTO', 'CONFIRMADO', 'RECUSADO', 'CANCELADO', 'ESTORNADO');

-- CreateTable
CREATE TABLE "orcamentos" (
    "id" TEXT NOT NULL,
    "ordem_servico_id" TEXT NOT NULL,
    "valor_total_servicos" DECIMAL(10,2) NOT NULL,
    "valor_total_pecas" DECIMAL(10,2) NOT NULL,
    "valor_total_geral" DECIMAL(10,2) NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orcamentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagamentos" (
    "id" TEXT NOT NULL,
    "ordem_servico_id" TEXT NOT NULL,
    "valor" DECIMAL(10,2) NOT NULL,
    "status" "StatusPagamento" NOT NULL DEFAULT 'AGUARDANDO_PAGAMENTO',
    "preference_id" TEXT,
    "link_pagamento" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pagamentos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orcamentos_ordem_servico_id_key" ON "orcamentos"("ordem_servico_id");

-- CreateIndex
CREATE UNIQUE INDEX "pagamentos_ordem_servico_id_key" ON "pagamentos"("ordem_servico_id");

