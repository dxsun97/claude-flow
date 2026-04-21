import type {
  SessionData,
  SessionAnalytics,
  ToolStats,
  TokenUsage,
} from '@/types/session'
import type { SubagentInfo } from '@/store/session-store'

export { formatTokenCount, formatDuration } from '@ccsight/shared'

export function computeAnalytics(session: SessionData): SessionAnalytics {
  const toolStatsMap = new Map<string, ToolStats>()

  for (const turn of session.turns) {
    for (const tc of turn.toolCalls) {
      const name = tc.toolUse.name
      const existing = toolStatsMap.get(name) ?? {
        name,
        count: 0,
        errors: 0,
        totalDurationMs: 0,
      }
      existing.count++
      if (tc.isError) existing.errors++
      if (tc.durationMs) existing.totalDurationMs += tc.durationMs
      toolStatsMap.set(name, existing)
    }
  }

  const toolStats = Array.from(toolStatsMap.values()).sort(
    (a, b) => b.count - a.count,
  )

  const tokensPerTurn = session.turns.map((turn) => ({
    turnIndex: turn.index,
    input: turn.totalTokens.input_tokens,
    output: turn.totalTokens.output_tokens,
    cached: turn.totalTokens.cache_read_input_tokens ?? 0,
  }))

  const totalMessages = session.turns.reduce(
    (acc, t) => acc + 1 + t.assistantMessages.length + t.toolCalls.length,
    0,
  )

  return {
    totalTurns: session.turns.length,
    totalMessages,
    totalTokens: session.totalTokens,
    toolStats,
    tokensPerTurn,
    totalDurationMs: session.endTime.getTime() - session.startTime.getTime(),
  }
}

export function getToolColor(toolName: string): string {
  const colors: Record<string, string> = {
    Bash: '#22c55e',
    Read: '#3b82f6',
    Glob: '#3b82f6',
    Grep: '#3b82f6',
    Write: '#f97316',
    Edit: '#f97316',
    NotebookEdit: '#f97316',
    WebSearch: '#a855f7',
    WebFetch: '#a855f7',
    Agent: '#6366f1',
    Skill: '#6366f1',
    AskUserQuestion: '#eab308',
    TaskCreate: '#14b8a6',
    TaskUpdate: '#14b8a6',
    TaskList: '#14b8a6',
    TaskGet: '#14b8a6',
  }
  return colors[toolName] ?? '#71717a'
}

export function getToolCategory(toolName: string): string {
  const categories: Record<string, string> = {
    Bash: 'execution',
    Read: 'file-read',
    Glob: 'file-read',
    Grep: 'file-read',
    Write: 'file-write',
    Edit: 'file-write',
    NotebookEdit: 'file-write',
    WebSearch: 'web',
    WebFetch: 'web',
    Agent: 'agent',
    Skill: 'agent',
    AskUserQuestion: 'interaction',
  }
  return categories[toolName] ?? 'other'
}

interface ModelPricing {
  input: number // $/M tokens
  output: number // $/M tokens
  cacheRead: number
  cacheWrite: number
  webSearch: number // $ per request
}

// Pricing tiers from Claude Code CLI source (utils/modelCost.ts)
const PRICING: Record<string, ModelPricing> = {
  'opus-4.6': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    webSearch: 0.01,
  },
  'opus-4.5': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    webSearch: 0.01,
  },
  'opus-4.1': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    webSearch: 0.01,
  },
  'opus-4': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    webSearch: 0.01,
  },
  sonnet: {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    webSearch: 0.01,
  },
  'haiku-4.5': {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    webSearch: 0.01,
  },
  'haiku-3.5': {
    input: 0.8,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1.0,
    webSearch: 0.01,
  },
}

function getPricing(model: string): ModelPricing {
  const m = model.toLowerCase()
  // Try exact match first
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (m.includes(key)) return pricing
  }
  // Fallback by family
  if (m.includes('haiku')) return PRICING['haiku-4.5']
  if (m.includes('sonnet')) return PRICING['sonnet']
  if (m.includes('opus')) return PRICING['opus-4.6']
  return PRICING['opus-4.6']
}

function costForUsage(usage: TokenUsage, pricing: ModelPricing): number {
  const M = 1_000_000
  return (
    (usage.input_tokens / M) * pricing.input +
    (usage.output_tokens / M) * pricing.output +
    ((usage.cache_read_input_tokens ?? 0) / M) * pricing.cacheRead +
    ((usage.cache_creation_input_tokens ?? 0) / M) * pricing.cacheWrite +
    (usage.server_tool_use?.web_search_requests ?? 0) * pricing.webSearch
  )
}

export function estimateCost(usage: TokenUsage): number {
  return costForUsage(usage, PRICING['opus-4.6'])
}

export function estimateSessionCost(
  session: SessionData,
  subagents?: SubagentInfo[],
): number {
  let total = 0
  // Main session: per-message model-aware cost
  for (const turn of session.turns) {
    for (const am of turn.assistantMessages) {
      total += costForUsage(am.message.usage, getPricing(am.message.model))
    }
  }
  // Subagent costs from server-provided per-model token totals
  if (subagents) {
    for (const sa of subagents) {
      for (const mt of sa.tokensByModel ?? []) {
        total += costForUsage(mt as TokenUsage, getPricing(mt.model))
      }
    }
  }
  return total
}
