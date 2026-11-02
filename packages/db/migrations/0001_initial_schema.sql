CREATE TYPE "public"."document_file_type" AS ENUM('pdf', 'docx', 'txt');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(384) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_chunk_index_non_negative" CHECK ("chunks"."chunk_index" >= 0),
	CONSTRAINT "chunks_token_count_positive" CHECK ("chunks"."token_count" > 0),
	CONSTRAINT "chunks_content_not_empty" CHECK (char_length("chunks"."content") > 0)
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "conversations_title_length" CHECK (char_length("conversations"."title") <= 200)
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"file_type" "document_file_type" NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "documents_filename_length" CHECK (char_length("documents"."filename") between 1 and 255),
	CONSTRAINT "documents_file_size_positive" CHECK ("documents"."file_size_bytes" > 0),
	CONSTRAINT "documents_storage_path_in_owner_folder" CHECK ("documents"."storage_path" ~ ('^' || "documents"."user_id"::text || '/[A-Za-z0-9][A-Za-z0-9._-]*$'))
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"cited_chunk_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_content_not_empty" CHECK (char_length("messages"."content") > 0)
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_owner_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_document_owner_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_owner_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversations"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_id_chunk_index_key" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "chunks_user_id_idx" ON "chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "conversations_user_id_updated_at_idx" ON "conversations" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_document_id_idx" ON "conversations" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_storage_path_key" ON "documents" USING btree ("storage_path");--> statement-breakpoint
CREATE INDEX "documents_user_id_created_at_idx" ON "documents" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE POLICY "chunks_select_own" ON "chunks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("chunks"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "conversations_select_own" ON "conversations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("conversations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "conversations_insert_own" ON "conversations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("conversations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "conversations_update_own" ON "conversations" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("conversations"."user_id" = (select auth.uid())) WITH CHECK ("conversations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "conversations_delete_own" ON "conversations" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("conversations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "documents_select_own" ON "documents" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("documents"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "documents_insert_own" ON "documents" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("documents"."user_id" = (select auth.uid()) and "documents"."status" = 'pending');--> statement-breakpoint
CREATE POLICY "documents_delete_own" ON "documents" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("documents"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "messages_select_own" ON "messages" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("messages"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "messages_insert_own" ON "messages" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("messages"."user_id" = (select auth.uid()));