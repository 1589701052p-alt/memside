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
      enum: ['conversation', 'error', 'manual', 'subagent'],
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
    valueClass: text('value_class'), // nullable: decision|convention|trap|topology; null = unevaluated
    subjectSlug: text('subject_slug'), // nullable: kebab-case 主题归组键；null = 未分组（平铺注入）
    origin: text('origin'), // nullable: user-stated|user-confirmed|agent-observed；老行 NULL = 未标注（spec §数据模型）
    evidence: text('evidence'), // nullable: 出处原句摘抄；老行 NULL
  },
  (t) => ({
    scopeStatusIdx: index('idx_memories_scope_status').on(t.scopeType, t.scopeId, t.status),
    statusCreatedIdx: index('idx_memories_status_created').on(t.status, t.createdAt),
    subjectIdx: index('idx_memories_subject').on(t.scopeType, t.scopeId, t.subjectSlug),
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
    sessionId: text('session_id'), // 第五轮：claude code hook payload 的 session_id，增量偏移键
    sourceAgentId: text('source_agent_id'), // subagent 蒸馏任务的 agent_id；主会话任务为 null
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
    sessionIdx: index('idx_distill_jobs_session').on(t.sessionId),
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

export const memoryDiscards = sqliteTable(
  'memory_discards',
  {
    id: text('id').primaryKey(),
    distillJobId: text('distill_job_id')
      .notNull()
      .references(() => memoryDistillJobs.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    reason: text('reason').notNull(), // 'public-knowledge' | 'derivable' | 'taming' | 'fleeting'
    ts: integer('ts').notNull(),
    // 以下 6 列为本需求新增（nullable；迁移前老行为 NULL）：
    scopeType: text('scope_type'), // 'project' | 'global'
    scopeId: text('scope_id'), // project -> cwd, global -> null
    sourceCwd: text('source_cwd'),
    runtime: text('runtime'), // 'claude-code' | 'opencode'
    sourceKind: text('source_kind'), // 'conversation' | 'subagent'
    promotedMemoryId: text('promoted_memory_id'), // 提升 success 后回填 candidate.id
  },
  (t) => ({
    tsIdx: index('idx_discards_ts').on(t.ts),
  }),
)

export const memorySessionOffsets = sqliteTable(
  'memory_session_offsets',
  {
    sessionId: text('session_id').primaryKey(),
    lastTurnOffset: integer('last_turn_offset').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
)

export const memoryDistillInputs = sqliteTable(
  'memory_distill_inputs',
  {
    distillJobId: text('distill_job_id').primaryKey(),
    turnsJson: text('turns_json').notNull(),
    turnCount: integer('turn_count').notNull(),
    charCount: integer('char_count').notNull(),
    ts: integer('ts').notNull(),
  },
)

export const memoryDistillRuns = sqliteTable(
  'memory_distill_runs',
  {
    distillJobId: text('distill_job_id').primaryKey(),
    outcome: text('outcome').notNull(),
    rawOutputJson: text('raw_output_json'),
    distilledCount: integer('distilled_count').notNull(),
    acceptedCount: integer('accepted_count').notNull(),
    dedupedCount: integer('deduped_count').notNull(),
    filteredCount: integer('filtered_count').notNull(),
    storedCount: integer('stored_count').notNull(),
    discardedCount: integer('discarded_count').notNull(),
    durationMs: integer('duration_ms').notNull(),
    errorMessage: text('error_message'),   // 新增：nullable；llm_error 时存错误描述，其余 null
    ts: integer('ts').notNull(),
  },
)

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
