-- Aditiva (#325, ajuste da revisão de 28/10): OS afetada e desfecho da notificação no webhook_recebido.
-- Nulas: linhas anteriores e notificações sem gravação de linha continuam válidas.

-- AlterTable
ALTER TABLE "webhook_recebido" ADD COLUMN "ordem_servico_id" TEXT,
ADD COLUMN "resultado" TEXT;
