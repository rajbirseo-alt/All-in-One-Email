-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "isStarred" BOOLEAN NOT NULL DEFAULT false;

