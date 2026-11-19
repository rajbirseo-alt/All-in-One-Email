-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TASK_ASSIGNED';

-- AlterTable
ALTER TABLE "assignment_rules" ADD COLUMN     "createLead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leadServiceInterest" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "departmentId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "dueNotifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "contact_merges" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "moved" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "mergedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "contact_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_duplicate_dismissals" (
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "dismissedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_duplicate_dismissals_pkey" PRIMARY KEY ("aId","bId")
);

-- CreateIndex
CREATE INDEX "contact_merges_targetId_createdAt_idx" ON "contact_merges"("targetId", "createdAt");

-- CreateIndex
CREATE INDEX "contact_merges_sourceId_idx" ON "contact_merges"("sourceId");

-- CreateIndex
CREATE INDEX "leads_departmentId_idx" ON "leads"("departmentId");

-- CreateIndex
CREATE INDEX "leads_sourceThreadId_idx" ON "leads"("sourceThreadId");

-- CreateIndex
CREATE INDEX "tasks_status_dueAt_idx" ON "tasks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_threadId_idx" ON "tasks"("threadId");

-- CreateIndex
CREATE INDEX "tasks_leadId_idx" ON "tasks"("leadId");

-- CreateIndex
CREATE INDEX "tasks_contactId_idx" ON "tasks"("contactId");

-- AddForeignKey
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

