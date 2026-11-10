-- AlterTable
ALTER TABLE "User" ADD COLUMN "companyName" VARCHAR(200),
ADD COLUMN "codePro" VARCHAR(50);

-- CreateIndex
CREATE UNIQUE INDEX "User_codePro_key" ON "User"("codePro");
