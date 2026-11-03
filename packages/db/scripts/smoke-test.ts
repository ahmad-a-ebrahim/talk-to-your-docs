/**
 * Milestone 1 smoke test: proves pgvector, the schema's integrity rules and Row Level Security work against the
 * real Supabase database. Creates two throwaway users, runs the checks, then deletes the users, which cascades
 * to every row the test created.
 *
 * Run from the repo root: npm run db:smoke
 */
import { randomUUID } from 'node:crypto';
import { cosineDistance, eq, sql } from 'drizzle-orm';
import {
  chunks,
  conversations,
  createDb,
  documents,
  EMBEDDING_DIMENSIONS,
  messages,
  withUserContext,
} from '../src';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.',
  );
  process.exit(1);
}

// A single connection, so the "settings don't leak" check really reuses the connection the user context ran on.
const { db, close } = createDb(databaseUrl, { maxConnections: 1 });

const PG_ERROR = {
  insufficientPrivilege: '42501', // RLS policy rejected the row, or the role lacks the grant
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  dataException: '22000', // pgvector: wrong number of dimensions
} as const;

let failures = 0;

function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
    if (detail !== undefined) console.error('   ', detail);
  }
}

/** Postgres error code from a raw postgres.js error or from Drizzle's wrapper around one. */
function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

async function expectRejected(label: string, expectedCode: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(false, `${label}: it was ALLOWED`);
  } catch (err) {
    const code = pgErrorCode(err);
    check(
      code === expectedCode,
      `${label}: rejected (${code})`,
      code === expectedCode ? undefined : err,
    );
  }
}

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('Expected a row, got none');
  return row;
}

/** Unit vector along one axis. Same axis = cosine distance 0, different axes = distance 1. Easy to reason about. */
function axis(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  return v;
}

async function main() {
  const userA = randomUUID();
  const userB = randomUUID();

  try {
    console.log('\n1. Database setup');
    const { role: connectionRole } = one(
      await db.execute<{ role: string }>(sql`select current_user as role`),
    );
    const extension = await db.execute<{ extversion: string }>(
      sql`select extversion from pg_extension where extname = 'vector'`,
    );
    check(extension.length === 1, `pgvector installed (v${extension[0]?.extversion})`);

    const hnsw = await db.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'chunks' and indexdef ilike '%using hnsw%'
    `);
    check(hnsw.length === 1, 'HNSW index exists on chunks.embedding');

    const rls = await db.execute<{ relname: string; relrowsecurity: boolean }>(sql`
      select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in ('documents', 'chunks', 'conversations', 'messages')
    `);
    check(
      rls.length === 4 && rls.every((t) => t.relrowsecurity),
      'RLS enabled on all 4 tables',
      rls,
    );

    console.log('\n2. Test data: two throwaway users, one document each');
    await db.execute(sql`
      insert into auth.users (id, email, aud, role) values
        (${userA}::uuid, ${`smoke-a-${userA}@example.invalid`}, 'authenticated', 'authenticated'),
        (${userB}::uuid, ${`smoke-b-${userB}@example.invalid`}, 'authenticated', 'authenticated')
    `);
    const docA = one(
      await db
        .insert(documents)
        .values({
          userId: userA,
          filename: 'a.txt',
          fileType: 'txt',
          fileSizeBytes: 10,
          storagePath: `${userA}/a.txt`,
        })
        .returning(),
    );
    const docB = one(
      await db
        .insert(documents)
        .values({
          userId: userB,
          filename: 'b.txt',
          fileType: 'txt',
          fileSizeBytes: 10,
          storagePath: `${userB}/b.txt`,
        })
        .returning(),
    );
    await db.insert(chunks).values([
      {
        documentId: docA.id,
        userId: userA,
        chunkIndex: 0,
        content: 'A0',
        tokenCount: 1,
        embedding: axis(0),
      },
      {
        documentId: docA.id,
        userId: userA,
        chunkIndex: 1,
        content: 'A1',
        tokenCount: 1,
        embedding: axis(1),
      },
      // Deliberately the SAME vector as A0: the perfect match for A's query, and it must still never reach A.
      {
        documentId: docB.id,
        userId: userB,
        chunkIndex: 0,
        content: 'B0',
        tokenCount: 1,
        embedding: axis(0),
      },
    ]);
    check(true, 'created 2 users, 2 documents, 3 chunks (B0 has the same vector as A0)');

    console.log('\n3. Vector search as user A (note: the query has NO "where user_id" on purpose)');
    const query = axis(0);
    const distance = cosineDistance(chunks.embedding, query);
    const results = await withUserContext(db, userA, (tx) =>
      tx
        .select({ content: chunks.content, userId: chunks.userId, distance })
        .from(chunks)
        .orderBy(distance)
        .limit(5),
    );
    check(
      results[0]?.content === 'A0' && Number(results[0].distance) < 1e-6,
      'nearest chunk is A0 at cosine distance 0',
      results,
    );
    check(
      results.length === 2 && results.every((r) => r.userId === userA),
      'only A’s 2 chunks come back; B0 is invisible',
      results,
    );

    const asB = await withUserContext(db, userB, (tx) =>
      tx.select({ content: chunks.content }).from(chunks),
    );
    check(asB.length === 1 && asB[0]?.content === 'B0', 'user B sees only B0');

    console.log(
      '\n4. What a signed-in user may and may not do (enforced by Postgres, not app code)',
    );
    const ownUpload = await withUserContext(db, userA, (tx) =>
      tx
        .insert(documents)
        .values({
          userId: userA,
          filename: 'ok.txt',
          fileType: 'txt',
          fileSizeBytes: 1,
          storagePath: `${userA}/ok.txt`,
        })
        .returning({ id: documents.id }),
    );
    check(ownUpload.length === 1, 'A can add its own pending document');

    await expectRejected('A adds a document owned by B', PG_ERROR.insufficientPrivilege, () =>
      withUserContext(db, userA, (tx) =>
        tx.insert(documents).values({
          userId: userB,
          filename: 'x.txt',
          fileType: 'txt',
          fileSizeBytes: 1,
          storagePath: `${userB}/x.txt`,
        }),
      ),
    );
    await expectRejected(
      "A adds a document already marked 'ready'",
      PG_ERROR.insufficientPrivilege,
      () =>
        withUserContext(db, userA, (tx) =>
          tx.insert(documents).values({
            userId: userA,
            filename: 'x.txt',
            fileType: 'txt',
            fileSizeBytes: 1,
            storagePath: `${userA}/x.txt`,
            status: 'ready',
          }),
        ),
    );
    await expectRejected('A changes its document status', PG_ERROR.insufficientPrivilege, () =>
      withUserContext(db, userA, (tx) =>
        tx.update(documents).set({ status: 'ready' }).where(eq(documents.id, docA.id)),
      ),
    );
    await expectRejected('A writes a chunk directly', PG_ERROR.insufficientPrivilege, () =>
      withUserContext(db, userA, (tx) =>
        tx.insert(chunks).values({
          documentId: docA.id,
          userId: userA,
          chunkIndex: 9,
          content: 'x',
          tokenCount: 1,
          embedding: axis(9),
        }),
      ),
    );
    await expectRejected('A starts a chat on B’s document', PG_ERROR.foreignKeyViolation, () =>
      withUserContext(db, userA, (tx) =>
        tx.insert(conversations).values({ userId: userA, documentId: docB.id }),
      ),
    );
    const deletedByA = await withUserContext(db, userA, (tx) =>
      tx.delete(documents).where(eq(documents.id, docB.id)).returning({ id: documents.id }),
    );
    check(deletedByA.length === 0, 'A deleting B’s document silently affects 0 rows');

    console.log('\n5. Integrity rules (hold even for privileged writers like n8n)');
    await expectRejected(
      'chunk claims a different owner than its document',
      PG_ERROR.foreignKeyViolation,
      () =>
        db.insert(chunks).values({
          documentId: docA.id,
          userId: userB,
          chunkIndex: 5,
          content: 'x',
          tokenCount: 1,
          embedding: axis(5),
        }),
    );
    await expectRejected(
      'document points at a file in another user’s folder',
      PG_ERROR.checkViolation,
      () =>
        db.insert(documents).values({
          userId: userA,
          filename: 'x.txt',
          fileType: 'txt',
          fileSizeBytes: 1,
          storagePath: `${userB}/x.txt`,
        }),
    );
    await expectRejected(
      'embedding with the wrong number of dimensions',
      PG_ERROR.dataException,
      () =>
        db.insert(chunks).values({
          documentId: docA.id,
          userId: userA,
          chunkIndex: 6,
          content: 'x',
          tokenCount: 1,
          embedding: [1, 0, 0],
        }),
    );

    console.log('\n6. User context does not leak into the pooled connection');
    const after = one(
      await db.execute<{ role: string; claims: string | null }>(
        sql`select current_user as role, nullif(current_setting('request.jwt.claims', true), '') as claims`,
      ),
    );
    check(
      after.role === connectionRole && after.claims === null,
      `connection is back to '${after.role}' with no JWT claims`,
      after,
    );

    console.log('\n7. Chats: forged fields, message order, activity, and what users may edit');
    const forgedDoc = one(
      await withUserContext(db, userA, (tx) =>
        tx
          .insert(documents)
          .values({
            userId: userA,
            filename: 'forged.txt',
            fileType: 'txt',
            fileSizeBytes: 1,
            storagePath: `${userA}/forged.txt`,
            errorMessage: 'forged',
            createdAt: new Date('2000-01-01'),
          })
          .returning({ errorMessage: documents.errorMessage, createdAt: documents.createdAt }),
      ),
    );
    check(
      forgedDoc.errorMessage === null && forgedDoc.createdAt.getFullYear() > 2020,
      'server-managed document fields (error_message, created_at) are overwritten, not trusted',
      forgedDoc,
    );

    const conversation = one(
      await withUserContext(db, userA, (tx) =>
        tx.insert(conversations).values({ userId: userA }).returning(),
      ),
    );
    const [first, second] = await withUserContext(db, userA, async (tx) => {
      // Two messages in ONE transaction, like the question + answer the API will save together.
      const q1 = one(
        await tx
          .insert(messages)
          .values({
            conversationId: conversation.id,
            userId: userA,
            role: 'user',
            content: 'q1',
            citedChunkIds: [randomUUID()],
            createdAt: new Date('2000-01-01'),
          })
          .returning(),
      );
      const q2 = one(
        await tx
          .insert(messages)
          .values({
            conversationId: conversation.id,
            userId: userA,
            role: 'user',
            content: 'q2',
          })
          .returning(),
      );
      return [q1, q2] as const;
    });
    check(
      second.createdAt.getTime() > first.createdAt.getTime(),
      'two messages saved in one transaction get strictly increasing created_at (stable order)',
      { first: first.createdAt, second: second.createdAt },
    );
    check(
      first.citedChunkIds.length === 0 && first.createdAt.getFullYear() > 2020,
      'a user can’t forge citations or backdate a message',
      first,
    );
    await expectRejected(
      'A writes a message as the assistant',
      PG_ERROR.insufficientPrivilege,
      () =>
        withUserContext(db, userA, (tx) =>
          tx.insert(messages).values({
            conversationId: conversation.id,
            userId: userA,
            role: 'assistant',
            content: 'forged answer',
          }),
        ),
    );

    const [touched] = await db
      .select({ updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    check(
      touched !== undefined && touched.updatedAt.getTime() > conversation.updatedAt.getTime(),
      'adding a message moves the conversation’s updated_at (trigger)',
    );

    const renamed = await withUserContext(db, userA, (tx) =>
      tx
        .update(conversations)
        .set({ title: 'Renamed' })
        .where(eq(conversations.id, conversation.id))
        .returning({ title: conversations.title }),
    );
    check(renamed[0]?.title === 'Renamed', 'A can rename its conversation');
    await expectRejected(
      'A edits a conversation’s created_at',
      PG_ERROR.insufficientPrivilege,
      () =>
        withUserContext(db, userA, (tx) =>
          tx
            .update(conversations)
            .set({ createdAt: new Date('2000-01-01') })
            .where(eq(conversations.id, conversation.id)),
        ),
    );

    console.log('\n8. Database-maintained fields and cascades');
    const updated = one(
      await db
        .update(documents)
        .set({ status: 'processing' })
        .where(eq(documents.id, docA.id))
        .returning({ updatedAt: documents.updatedAt }),
    );
    check(
      updated.updatedAt.getTime() > docA.updatedAt.getTime(),
      'updated_at moves forward on update (trigger, no app code involved)',
    );

    // Intentional: a chat scoped to a document goes with it, because its citations would point at deleted chunks.
    const scopedChat = one(
      await db.insert(conversations).values({ userId: userA, documentId: docA.id }).returning(),
    );
    await db.delete(documents).where(eq(documents.id, docA.id));
    const orphans = await db
      .select({ id: chunks.id })
      .from(chunks)
      .where(eq(chunks.documentId, docA.id));
    check(orphans.length === 0, 'deleting a document removes its chunks');
    const goneChats = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, scopedChat.id));
    check(goneChats.length === 0, 'deleting a document removes chats scoped to it (intentional)');
  } finally {
    try {
      await db.execute(sql`delete from auth.users where id in (${userA}::uuid, ${userB}::uuid)`);
      console.log('\nCleaned up: test users deleted (their rows went with them via cascade).');
    } catch (err) {
      console.error(
        `\nCleanup failed. Delete these users from auth.users by hand: ${userA}, ${userB}`,
        err,
      );
    }
    await close();
  }
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll checks passed.');
    }
  })
  .catch((err) => {
    console.error('\nSmoke test crashed:', err);
    if (pgErrorCode(err) === PG_ERROR.insufficientPrivilege) {
      console.error(
        'Hint: the connection role may not be allowed to write to auth.users in this project.',
      );
    }
    process.exitCode = 1;
  });
