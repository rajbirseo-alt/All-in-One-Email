-- AlterTable
ALTER TABLE "email_threads" ADD COLUMN     "slaNextAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "email_threads_slaNextAt_idx" ON "email_threads"("slaNextAt");

-- CreateIndex
CREATE INDEX "email_threads_followUpAt_idx" ON "email_threads"("followUpAt");
