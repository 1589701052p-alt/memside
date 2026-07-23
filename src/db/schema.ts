import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scopeType: text('scope_type', { enum: ['project', 'global'] }).notNull(),
    scopeId: text('scope_id'), // null iff scopeType='global'
    runtime: text('runtime', { enum: ['claude-code', 'opencode'] }), // optional tag
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    tags: text('tags').notNull().default('[]'), // JSON string[]
    status: text('status', {
      enum: ['candidate', 'approved', 'archived', 'superseded', 'rejected'],
    }).notNull(),
    sourceKind: text('source_kind', {
      enum: ['conversation', 'error', 'manual'],
    }).notNull(),
    sourceCwd: text('source_cwd'), // 来源项目 cwd；蒸馏来自 job.cwd，手动记忆为 null
    sourceEventId: text('source_event_id'),
    distillJobId: text('distill_job_id'),
    distillAction: text('distill_action', {
      enum: ['new', 'update_of', 'duplicate_of', 'conflict_with'],
    }),
    supersedesId: text('supersedes_id'),
    supersededById: text('superseded_by_id'),
    approvedAt: integer('approved_at'),
    createdAt: integer('created_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => ({
    scopeStatusIdx: index('idx_memories_scope_status').on(t.scopeType, t.scopeId, t.status),
    statusCreatedIdx: index('idx_memories_status_created').on(t.status, t.createdAt),
  }),
)

export const memoryDistillJobs = sqliteTable(
  'memory_distill_jobs',
  {
    id: text('id').primaryKey(),
    debounceKey: text('debounce_key').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    runtime: text('runtime', { enum: ['claude-code', 'opencode'] }).notNull(),
    cwd: text('cwd'), // project scope resolver input
    scopeResolvedJson: text('scope_resolved_json'), // {projectId, includeGlobal}
    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'canceled'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextRunAt: integer('next_run_at').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => ({
    statusNextIdx: index('idx_distill_jobs_status_next').on(t.status, t.nextRunAt),
    debounceIdx: index('idx_distill_jobs_debounce').on(t.debounceKey, t.status),
  }),
)

export const memoryDistillEvents = sqliteTable(
  'memory_distill_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    distillJobId: text('distill_job_id')
      .notNull()
      .references(() => memoryDistillJobs.id, { onDelete: 'cascade' }),
    attemptIndex: integer('attempt_index').notNull(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(), // 'conversation' | 'error' | 'blame' | 'capture-failed'
    payload: text('payload').notNull(), // JSON: transcript excerpt / error detail
  },
  (t) => ({
    jobAttemptIdx: index('idx_distill_events_job_attempt').on(t.distillJobId, t.attemptIndex, t.ts),
  }),
)
