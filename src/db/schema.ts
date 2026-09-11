import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Records a fact; nothing in the application authorizes on it. NULL means
  // nobody proved control of the mailbox, including for every account that
  // predates this column. See docs/adr/0011-email-verification-is-advisory.md.
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    // sha256 of the opaque token; the raw token never touches the database.
    // Two identifiers live on this row and the naming is deliberately not
    // symmetric: `id` is the secret-derived one and never leaves the server,
    // `public_id` is the one that appears in responses and URLs. See ADR 0014.
    id: text('id').primaryKey(),
    // Nullable in the database until the contract migration; modelled as
    // notNull because the 0005 default plus backfill means no code path can
    // read or write a NULL.
    publicId: uuid('public_id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Attacker-controlled text, truncated at write time and never logged.
    // NULL for a client that sent no header and for every pre-F-009 row.
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const todos = pgTable(
  'todos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    completed: boolean('completed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // NULL means live; a timestamp means the owner deleted it then. Nullable
    // permanently — NULL is a value this design relies on, not a gap awaiting a
    // backfill — so there is no contract migration, ever. Every read of this
    // table must say which rows it means, in SQL, at the call site.
    // See docs/adr/0016-soft-delete-is-a-nullable-timestamp.md.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('todos_user_id_created_at_idx').on(t.userId, t.createdAt)],
);

// One row per (user, Idempotency-Key). No secondary index: the composite
// primary key serves both the claim/lookup and the retention sweep.
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status', { enum: ['in_progress', 'completed'] }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// One live reset token per account: the primary key on user_id *is* the
// "at most one" invariant, and issuing is an upsert on it. Consuming is a
// DELETE on token_hash, served by the unique constraint. No secondary index,
// and no retention job — the table is capped at one row per account.
// See docs/adr/0009-single-use-recovery-tokens.md.
export const passwordResetTokens = pgTable('password_reset_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // sha256 of the opaque token; the raw token never touches the database.
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ADR 0009's shape, unchanged: same key, same unique constraint, same absence
// of a secondary index and of a retention job. Issuing is an upsert on the
// primary key, consuming is a DELETE on token_hash.
export const emailVerificationTokens = pgTable('email_verification_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // sha256 of the opaque token; the raw token never touches the database.
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  todos: many(todos),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const todosRelations = relations(todos, ({ one }) => ({
  user: one(users, { fields: [todos.userId], references: [users.id] }),
}));

export const schema = {
  users,
  sessions,
  todos,
  idempotencyKeys,
  passwordResetTokens,
  emailVerificationTokens,
  usersRelations,
  sessionsRelations,
  todosRelations,
};
