-- CreateEnum
CREATE TYPE "TrackingClassification" AS ENUM ('ai', 'other');

-- CreateTable
CREATE TABLE "tracking_events" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "classification" "TrackingClassification" NOT NULL,
    "source" TEXT,
    "matched_by" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "referrer_domain" TEXT,
    "landing_path" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_events_shop_id_occurred_at_idx" ON "tracking_events"("shop_id", "occurred_at");

-- CreateIndex
CREATE INDEX "tracking_events_shop_id_classification_occurred_at_idx" ON "tracking_events"("shop_id", "classification", "occurred_at");

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
