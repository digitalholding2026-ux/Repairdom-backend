-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('END_OF_SERVICE', 'DEPOSIT_50');

-- AlterTable
ALTER TABLE "CatalogItem" ADD COLUMN "paymentType" "PaymentType" NOT NULL DEFAULT 'END_OF_SERVICE';

-- AlterTable
ALTER TABLE "Demande" ADD COLUMN "discountCodeUsed" TEXT;
