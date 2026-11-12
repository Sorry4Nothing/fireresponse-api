ALTER TABLE "programm" ADD COLUMN "nur_leitende" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "einheit" DROP COLUMN "anmelde_arten";