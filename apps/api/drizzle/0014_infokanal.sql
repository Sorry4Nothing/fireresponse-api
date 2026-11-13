CREATE TABLE "infokanal_gelesen" (
	"user_id" uuid NOT NULL,
	"einheit_id" uuid NOT NULL,
	"gelesen_bis" timestamp with time zone NOT NULL,
	CONSTRAINT "infokanal_gelesen_user_id_einheit_id_pk" PRIMARY KEY("user_id","einheit_id")
);
--> statement-breakpoint
CREATE TABLE "infokanal_mitteilung" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"einheit_id" uuid NOT NULL,
	"autor_id" uuid,
	"text" text,
	"bearbeitet_am" timestamp with time zone,
	"geloescht_am" timestamp with time zone,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infokanal_mitteilung_text_check" CHECK (("infokanal_mitteilung"."geloescht_am" is null and "infokanal_mitteilung"."text" is not null and char_length("infokanal_mitteilung"."text") between 1 and 2000) or ("infokanal_mitteilung"."geloescht_am" is not null and "infokanal_mitteilung"."text" is null and "infokanal_mitteilung"."autor_id" is null))
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "push_infokanal" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "infokanal_gelesen" ADD CONSTRAINT "infokanal_gelesen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infokanal_gelesen" ADD CONSTRAINT "infokanal_gelesen_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infokanal_mitteilung" ADD CONSTRAINT "infokanal_mitteilung_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infokanal_mitteilung" ADD CONSTRAINT "infokanal_mitteilung_autor_id_user_id_fk" FOREIGN KEY ("autor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infokanal_mitteilung_einheit_idx" ON "infokanal_mitteilung" USING btree ("einheit_id","id");--> statement-breakpoint
CREATE INDEX "infokanal_mitteilung_erstellt_idx" ON "infokanal_mitteilung" USING btree ("erstellt_am");--> statement-breakpoint
CREATE INDEX "infokanal_mitteilung_autor_idx" ON "infokanal_mitteilung" USING btree ("autor_id");