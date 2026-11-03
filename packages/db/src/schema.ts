import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid, authUsers } from 'drizzle-orm/supabase';

/**
 * gte-small (the only model Supabase's Edge Runtime ships) outputs 384-dim vectors.
 * Changing the embedding model means a new migration AND re-embedding every chunk.
 */
export const EMBEDDING_DIMENSIONS = 384;

export const documentStatus = pgEnum('document_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);
export const documentFileType = pgEnum('document_file_type', ['pdf', 'docx', 'txt']);
export const messageRole = pgEnum('message_role', ['user', 'assistant']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
// Kept current by a DB trigger (see migrations), so it's right no matter who writes: Express, n8n, or the SQL editor.
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * The one RLS rule every table uses: the row belongs to the signed-in user.
 * `authUid` is `(select auth.uid())`; the sub-select lets Postgres evaluate it once per query instead of once per row.
 */
const isOwner = (userId: AnyPgColumn): SQL => sql`${userId} = ${authUid}`;

/*
 * Ownership model: every table carries `user_id`. Parent tables expose a UNIQUE (id, user_id) pair, and child
 * tables reference it with a two-column foreign key. That makes it impossible for a chunk, conversation or message
 * to belong to a different user than its parent, so every RLS policy can be the same one-line `isOwner` check.
 */

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    fileType: documentFileType('file_type').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    status: documentStatus('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('documents_id_user_id_key').on(t.id, t.userId),
    uniqueIndex('documents_storage_path_key').on(t.storagePath),
    index('documents_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
    check('documents_filename_length', sql`char_length(${t.filename}) between 1 and 255`),
    check('documents_file_size_positive', sql`${t.fileSizeBytes} > 0`),
    // The file must sit directly under the owner's folder ("<user_id>/<name>"). n8n downloads files by this path
    // with privileged credentials, so a row pointing at another user's file would leak it into the wrong account.
    check(
      'documents_storage_path_in_owner_folder',
      sql`${t.storagePath} ~ ('^' || ${t.userId}::text || '/[A-Za-z0-9][A-Za-z0-9._-]*$')`,
    ),
    pgPolicy('documents_select_own', {
      for: 'select',
      to: authenticatedRole,
      using: isOwner(t.userId),
    }),
    // New uploads always start as 'pending'; only the ingestion pipeline (privileged) moves them forward.
    pgPolicy('documents_insert_own', {
      for: 'insert',
      to: authenticatedRole,
      withCheck: sql`${isOwner(t.userId)} and ${t.status} = 'pending'`,
    }),
    pgPolicy('documents_delete_own', {
      for: 'delete',
      to: authenticatedRole,
      using: isOwner(t.userId),
    }),
  ],
);

/** Free-form extras from ingestion, e.g. `{ page: 4 }` so a citation can point at a page. */
export type ChunkMetadata = Record<string, unknown>;

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').notNull(),
    // Copied from the document so vector search filters on one column, no join needed.
    userId: uuid('user_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    metadata: jsonb('metadata').$type<ChunkMetadata>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'chunks_document_owner_fk',
      columns: [t.documentId, t.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete('cascade'),
    uniqueIndex('chunks_document_id_chunk_index_key').on(t.documentId, t.chunkIndex),
    index('chunks_user_id_idx').on(t.userId),
    // HNSW = approximate nearest-neighbour graph. Unlike IVFFlat it needs no training data, so it works on an empty table.
    index('chunks_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    check('chunks_chunk_index_non_negative', sql`${t.chunkIndex} >= 0`),
    check('chunks_token_count_positive', sql`${t.tokenCount} > 0`),
    check('chunks_content_not_empty', sql`char_length(${t.content}) > 0`),
    // Read-only for users. Chunks are written by the ingestion pipeline and removed by cascade.
    pgPolicy('chunks_select_own', {
      for: 'select',
      to: authenticatedRole,
      using: isOwner(t.userId),
    }),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    // NULL = chat across all of the user's documents.
    documentId: uuid('document_id'),
    title: text('title'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('conversations_id_user_id_key').on(t.id, t.userId),
    // A document-scoped chat must use the user's own document. When document_id is NULL the FK isn't checked.
    // Deleting the document deletes its chats: their citations would point at chunks that no longer exist.
    foreignKey({
      name: 'conversations_document_owner_fk',
      columns: [t.documentId, t.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete('cascade'),
    index('conversations_user_id_updated_at_idx').on(t.userId, t.updatedAt.desc()),
    index('conversations_document_id_idx').on(t.documentId),
    check('conversations_title_length', sql`char_length(${t.title}) <= 200`),
    pgPolicy('conversations_select_own', {
      for: 'select',
      to: authenticatedRole,
      using: isOwner(t.userId),
    }),
    pgPolicy('conversations_insert_own', {
      for: 'insert',
      to: authenticatedRole,
      withCheck: isOwner(t.userId),
    }),
    pgPolicy('conversations_update_own', {
      for: 'update',
      to: authenticatedRole,
      using: isOwner(t.userId),
      withCheck: isOwner(t.userId),
    }),
    pgPolicy('conversations_delete_own', {
      for: 'delete',
      to: authenticatedRole,
      using: isOwner(t.userId),
    }),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: messageRole('role').notNull(),
    content: text('content').notNull(),
    // Plain array, no FK: if a document is re-ingested, old citations simply stop resolving. RLS on `chunks`
    // still guarantees an ID here can only ever resolve to the user's own chunks.
    citedChunkIds: uuid('cited_chunk_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // clock_timestamp() is the real time of each row. now() is the transaction's START time, so the user's
    // question and the assistant's answer saved in one transaction would tie and sort in undefined order.
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    foreignKey({
      name: 'messages_conversation_owner_fk',
      columns: [t.conversationId, t.userId],
      foreignColumns: [conversations.id, conversations.userId],
    }).onDelete('cascade'),
    index('messages_conversation_id_created_at_idx').on(t.conversationId, t.createdAt),
    check('messages_content_not_empty', sql`char_length(${t.content}) > 0`),
    pgPolicy('messages_select_own', {
      for: 'select',
      to: authenticatedRole,
      using: isOwner(t.userId),
    }),
    // Users can only write their own questions. Assistant answers (and their citations) are generated by the
    // server and written through a privileged path, so a user can't forge what the AI "said" in their history.
    pgPolicy('messages_insert_own', {
      for: 'insert',
      to: authenticatedRole,
      withCheck: sql`${isOwner(t.userId)} and ${t.role} = 'user'`,
    }),
  ],
);
