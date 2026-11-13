CREATE TABLE "nachricht" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"titel" text NOT NULL,
	"text" text NOT NULL,
	"laeuft_ab_am" timestamp with time zone,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nachricht_titel_check" CHECK (char_length("nachricht"."titel") between 1 and 80),
	CONSTRAINT "nachricht_text_check" CHECK (char_length("nachricht"."text") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "nachricht_gelesen" (
	"nachricht_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"gelesen_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nachricht_gelesen_nachricht_id_user_id_pk" PRIMARY KEY("nachricht_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "nachricht_gelesen" ADD CONSTRAINT "nachricht_gelesen_nachricht_id_nachricht_id_fk" FOREIGN KEY ("nachricht_id") REFERENCES "public"."nachricht"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nachricht_gelesen" ADD CONSTRAINT "nachricht_gelesen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;