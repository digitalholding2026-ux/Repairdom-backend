-- AlterTable
CREATE TYPE "TargetDevice" AS ENUM ('MAC', 'PC', 'ALL');

-- AlterTable
ALTER TABLE "CatalogItem" ADD COLUMN "targetDevice" "TargetDevice" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "Demande" ADD COLUMN "extraRequirements" TEXT;
