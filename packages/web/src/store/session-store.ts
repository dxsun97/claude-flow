import { create } from 'zustand'
import type { SessionData, SessionAnalytics, RawMessage } from '@/types/session'
import type { DashboardStats } from '@/types/dashboard'
import type { DataSource, ProjectInfo } from '@ccsight/shared'
import { parseJsonl } from '@/lib/parser'
import { buildSession } from '@/lib/thread-builder'
import { computeAnalytics } from '@/lib/analytics'

export type { DataSource, ProjectInfo }

const API_BASE = import.meta.env.DEV ? 'http://localhost:3211' : ''

export interface SubagentModelTokens {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export interface SubagentInfo {
  id: string
  filename: string
  size: number
  tokensByModel?: SubagentModelTokens[]
}

interface SessionState {
  // Config
  dataSources: DataSource[]

  // Navigation context (set before navigating to session viewer)
  pendingSourceDir: string | null
  pendingProjectPath: string | null
  pendingModified: string | null

  // Project browser
  projects: ProjectInfo[]
  isLoadingProjects: boolean
  currentProjectDir: string | null
  currentSessionId: string | null
  currentSourceDir: string | null

  // Session viewer
  session: SessionData | null
  analytics: SessionAnalytics | null
  isLoading: boolean
  error: string | null
  selectedTurnIndex: number | null
  expandedToolIds: Set<string>
  filterTool: string | null

  // Streaming
  isStreaming: boolean
  isSessionLive: boolean

  // Dashboard
  dashboardStats: DashboardStats | null
  isDashboardLoading: boolean

  // Subagent
  subagents: SubagentInfo[]
  subagentSession: SessionData | null
  subagentAnalytics: SessionAnalytics | null
  isSubagentOpen: boolean
  isLoadingSubagent: boolean

  setNavigationContext: (
    sourceDir: string,
    projectPath: string,
    modified?: string,
  ) => void
  fetchConfig: () => Promise<void>
  saveConfig: (sources: DataSource[]) => Promise<void>
  fetchProjects: () => Promise<void>
  fetchDashboardStats: () => Promise<void>
  loadSession: (
    projectDir: string,
    sessionId: string,
    sourceDir: string,
    projectPath?: string,
  ) => Promise<void>
  streamSession: (
    projectDir: string,
    sessionId: string,
    sourceDir: string,
    projectPath?: string,
  ) => void
  stopStreaming: () => void
  loadSubagent: (agentId: string) => Promise<void>
  closeSubagent: () => void
  reset: () => void
  selectTurn: (index: number | null) => void
  toggleToolExpanded: (toolId: string) => void
  setFilterTool: (tool: string | null) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  dataSources: [],

  pendingSourceDir: null,
  pendingProjectPath: null,
  pendingModified: null,

  projects: [],
  isLoadingProjects: false,
  currentProjectDir: null,
  currentSessionId: null,
  currentSourceDir: null,

  isStreaming: false,
  isSessionLive: false,

  dashboardStats: null,
  isDashboardLoading: false,

  session: null,
  analytics: null,
  isLoading: false,
  error: null,
  selectedTurnIndex: null,
  expandedToolIds: new Set(),
  filterTool: null,

  subagents: [],
  subagentSession: null,
  subagentAnalytics: null,
  isSubagentOpen: false,
  isLoadingSubagent: false,

  setNavigationContext: (sourceDir, projectPath, modified?) => {
    set({
      pendingSourceDir: sourceDir,
      pendingProjectPath: projectPath,
      pendingModified: modified ?? null,
    })
    try {
      sessionStorage.setItem(
        'cf-nav',
        JSON.stringify({ sourceDir, projectPath, modified: modified ?? null }),
      )
    } catch {
      /* sessionStorage unavailable */
    }
  },

  fetchConfig: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config`)
      const data = await res.json()
      set({ dataSources: data.dataSources ?? [] })
    } catch {
      /* ignore */
    }
  },

  saveConfig: async (sources: DataSource[]) => {
    try {
      await fetch(`${API_BASE}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSources: sources }),
      })
      set({ dataSources: sources })
    } catch {
      /* ignore */
    }
  },

  fetchDashboardStats: async () => {
    set({ isDashboardLoading: true })
    try {
      const res = await fetch(`${API_BASE}/api/dashboard`)
      const data = await res.json()
      set({ dashboardStats: data, isDashboardLoading: false })
    } catch {
      set({ isDashboardLoading: false })
    }
  },

  fetchProjects: async () => {
    set({ isLoadingProjects: true })
    try {
      const res = await fetch(`${API_BASE}/api/projects`)
      const data = await res.json()
      set({ projects: data, isLoadingProjects: false })
    } catch {
      set({
        isLoadingProjects: false,
        error: 'Failed to connect to API server',
      })
    }
  },

  stopStreaming: () => {
    const state = get() as SessionState & { _eventSource?: EventSource }
    if (state._eventSource) {
      state._eventSource.close()
      ;(get() as unknown as Record<string, unknown>)._eventSource = undefined
    }
    set({ isStreaming: false, isSessionLive: false })
  },

  loadSession: async (
    projectDir: string,
    sessionId: string,
    sourceDir: string,
    projectPath?: string,
  ) => {
    // Stop any active streaming
    get().stopStreaming()

    set({ isLoading: true, error: null })
    try {
      const qs = `?sourceDir=${encodeURIComponent(sourceDir)}`
      const [sessionRes, subagentsRes] = await Promise.all([
        fetch(`${API_BASE}/api/sessions/${projectDir}/${sessionId}${qs}`),
        fetch(
          `${API_BASE}/api/sessions/${projectDir}/${sessionId}/subagents${qs}`,
        ),
      ])
      if (!sessionRes.ok) throw new Error('Failed to fetch session')

      const text = await sessionRes.text()
      const messages = parseJsonl(text)
      if (messages.length === 0) {
        throw new Error('No valid messages found in session')
      }
      const session = buildSession(messages)
      // Use projectPath from URL (project list) as fallback when JSONL lacks cwd
      if (session.projectPath === 'unknown' && projectPath) {
        session.projectPath = projectPath
      }
      const analytics = computeAnalytics(session)

      const subagents: SubagentInfo[] = subagentsRes.ok
        ? await subagentsRes.json()
        : []

      set({
        session,
        analytics,
        subagents,
        currentProjectDir: projectDir,
        currentSessionId: sessionId,
        currentSourceDir: sourceDir,
        isLoading: false,
        selectedTurnIndex: null,
        expandedToolIds: new Set(),
        filterTool: null,
        subagentSession: null,
        subagentAnalytics: null,
        isSubagentOpen: false,
      })
    } catch (e) {
      set({
        isLoading: false,
        error: e instanceof Error ? e.message : 'Failed to load session',
      })
    }
  },

  streamSession: (
    projectDir: string,
    sessionId: string,
    sourceDir: string,
    projectPath?: string,
  ) => {
    // Stop any active streaming first
    get().stopStreaming()

    set({
      isLoading: true,
      isStreaming: true,
      isSessionLive: true,
      error: null,
      selectedTurnIndex: null,
      expandedToolIds: new Set(),
      filterTool: null,
      currentProjectDir: projectDir,
      currentSessionId: sessionId,
      currentSourceDir: sourceDir,
      subagentSession: null,
      subagentAnalytics: null,
      isSubagentOpen: false,
    })

    // Fetch subagents in parallel (non-streaming)
    const qs = `?sourceDir=${encodeURIComponent(sourceDir)}`
    fetch(`${API_BASE}/api/sessions/${projectDir}/${sessionId}/subagents${qs}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((subagents: SubagentInfo[]) => set({ subagents }))
      .catch(() => set({ subagents: [] }))

    // Accumulate messages in closure
    const messages: RawMessage[] = []
    let initComplete = false
    let updateTimer: ReturnType<typeof setTimeout> | null = null

    function flushUpdate() {
      updateTimer = null
      if (messages.length === 0) return
      const session = buildSession([...messages])
      if (session.projectPath === 'unknown' && projectPath) {
        session.projectPath = projectPath
      }
      const analytics = computeAnalytics(session)
      set({ session, analytics })
    }

    function scheduleUpdate() {
      if (updateTimer) return
      // During initial burst, debounce aggressively; after init, update immediately
      const delay = initComplete ? 0 : 200
      if (delay === 0) {
        flushUpdate()
      } else {
        updateTimer = setTimeout(flushUpdate, delay)
      }
    }

    const url = `${API_BASE}/api/sessions/${projectDir}/${sessionId}/stream${qs}`
    const eventSource = new EventSource(url)

    // Store reference for cleanup (not a proper state field — attached as expando)
    ;(get() as unknown as Record<string, unknown>)._eventSource = eventSource

    eventSource.addEventListener('message', (e) => {
      try {
        const parsed = JSON.parse(e.data)
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          messages.push(parsed as RawMessage)
          scheduleUpdate()
        }
      } catch {
        /* skip malformed */
      }
    })

    eventSource.addEventListener('init-complete', () => {
      initComplete = true
      // Flush any pending updates and mark loading done
      if (updateTimer) {
        clearTimeout(updateTimer)
        updateTimer = null
      }
      flushUpdate()
      set({ isLoading: false })
    })

    eventSource.addEventListener('idle', () => {
      set({ isSessionLive: false })
    })

    eventSource.addEventListener('activity', () => {
      set({ isSessionLive: true })
    })

    eventSource.addEventListener('reset', () => {
      messages.length = 0
      flushUpdate()
    })

    eventSource.onerror = () => {
      // EventSource auto-reconnects; just mark as not live temporarily
      if (get().isStreaming) {
        set({ isSessionLive: false })
      }
    }
  },

  loadSubagent: async (agentId: string) => {
    const { currentProjectDir, currentSessionId, currentSourceDir } = get()
    if (!currentProjectDir || !currentSessionId) return

    set({ isLoadingSubagent: true, isSubagentOpen: true })
    try {
      const qs = currentSourceDir
        ? `?sourceDir=${encodeURIComponent(currentSourceDir)}`
        : ''
      const res = await fetch(
        `${API_BASE}/api/sessions/${currentProjectDir}/${currentSessionId}/subagents/${agentId}${qs}`,
      )
      if (!res.ok) throw new Error('Failed to fetch subagent')
      const text = await res.text()
      const messages = parseJsonl(text)
      const subagentSession = buildSession(messages)
      const subagentAnalytics = computeAnalytics(subagentSession)
      set({ subagentSession, subagentAnalytics, isLoadingSubagent: false })
    } catch {
      set({ isLoadingSubagent: false, isSubagentOpen: false })
    }
  },

  closeSubagent: () => {
    set({
      isSubagentOpen: false,
      subagentSession: null,
      subagentAnalytics: null,
    })
  },

  reset: () => {
    get().stopStreaming()
    set({
      session: null,
      analytics: null,
      isLoading: false,
      error: null,
      selectedTurnIndex: null,
      expandedToolIds: new Set(),
      filterTool: null,
      currentProjectDir: null,
      currentSessionId: null,
      currentSourceDir: null,
      subagents: [],
      subagentSession: null,
      subagentAnalytics: null,
      isSubagentOpen: false,
    })
  },

  selectTurn: (index) => set({ selectedTurnIndex: index }),

  toggleToolExpanded: (toolId) => {
    const expanded = new Set(get().expandedToolIds)
    if (expanded.has(toolId)) {
      expanded.delete(toolId)
    } else {
      expanded.add(toolId)
    }
    set({ expandedToolIds: expanded })
  },

  setFilterTool: (tool) => set({ filterTool: tool }),
}))
