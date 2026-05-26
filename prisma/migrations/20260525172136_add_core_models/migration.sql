-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('active', 'uninstalled');

-- CreateEnum
CREATE TYPE "LlmsFileSource" AS ENUM ('generated', 'manual_edit');

-- CreateEnum
CREATE TYPE "GenerationJobStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "proxy_path" TEXT NOT NULL DEFAULT '/apps/llms',
    "status" "ShopStatus" NOT NULL DEFAULT 'active',
    "redirect_id" TEXT,
    "web_pixel_id" TEXT,
    "last_generation_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llms_files" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "previous_content" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" "LlmsFileSource" NOT NULL DEFAULT 'generated',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llms_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "queue_job_id" TEXT,
    "status" "GenerationJobStatus" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_shop_domain_key" ON "shops"("shop_domain");

-- CreateIndex
CREATE UNIQUE INDEX "llms_files_shop_id_key" ON "llms_files"("shop_id");

-- CreateIndex
CREATE INDEX "generation_jobs_shop_id_created_at_idx" ON "generation_jobs"("shop_id", "created_at");

-- AddForeignKey
ALTER TABLE "llms_files" ADD CONSTRAINT "llms_files_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
