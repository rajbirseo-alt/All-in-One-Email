-- AlterTable
ALTER TABLE "automation_rules" ADD COLUMN     "departmentId" TEXT;

-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN     "aiEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

