-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "content" BYTEA,
ADD COLUMN     "sourceAttachmentId" TEXT;

-- AlterTable
ALTER TABLE "drafts" ADD COLUMN     "messageIdHeader" TEXT,
ADD COLUMN     "providerDraftId" TEXT;

