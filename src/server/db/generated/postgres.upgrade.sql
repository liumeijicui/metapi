ALTER TABLE "route_channels" ADD COLUMN "consecutive_upstream_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "route_channels" ADD COLUMN "auto_demoted_at" TEXT;
ALTER TABLE "route_channels" ADD COLUMN "priority_before_auto_demotion" INTEGER;
