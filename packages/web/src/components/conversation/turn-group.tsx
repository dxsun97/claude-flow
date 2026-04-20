import { useState, useRef, useEffect } from 'react'
import type { Turn, SystemMessage } from '@/types/session'
import { UserMessageBubble } from './user-message'
import { AssistantMessageBubble } from './assistant-message'
import { ToolCallCard } from './tool-call-card'
import { ExecutionFlowPopover } from './api-details-panel'
import { formatDuration, formatTokenCount } from '@/lib/analytics'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { Terminal, Workflow, Scissors } from 'lucide-react'

interface TurnGroupProps {
  turn: Turn
  isSelected: boolean
  onSelect: () => void
}

function extractTag(content: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  return re.exec(content)?.[1]?.trim() ?? ''
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function LocalCommandSystemMessage({ msg }: { msg: SystemMessage }) {
  const content = msg.content ?? ''
  const commandName = extractTag(content, 'command-name')
  const stdout = stripAnsi(extractTag(content, 'local-command-stdout'))

  if (!commandName && !stdout) return null

  return (
    <div className="flex gap-3 items-start">
      <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
        <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">Local Command</div>
        <div className="bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm">
          {commandName && (
            <code className="text-xs font-medium">{commandName}</code>
          )}
          {stdout && (
            <pre
              className={`text-xs text-muted-foreground whitespace-pre-wrap break-words${commandName ? ' mt-1.5' : ''}`}
            >
              {stdout}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

export function TurnGroup({ turn, isSelected, onSelect }: TurnGroupProps) {
  const [showFlow, setShowFlow] = useState(false)
  const flowBtnRef = useRef<HTMLButtonElement>(null)
  const flowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showFlow) return
    function handleClick(e: MouseEvent) {
      if (
        flowRef.current &&
        !flowRef.current.contains(e.target as Node) &&
        flowBtnRef.current &&
        !flowBtnRef.current.contains(e.target as Node)
      ) {
        setShowFlow(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showFlow])
  // Build a linear sequence of assistant text messages and tool calls
  const sequence: Array<
    | { type: 'assistant'; msg: (typeof turn.assistantMessages)[0] }
    | { type: 'tool'; call: (typeof turn.toolCalls)[0] }
  > = []

  let toolCallIdx = 0
  for (const assistantMsg of turn.assistantMessages) {
    const hasText = assistantMsg.message.content.some(
      (b) =>
        (b.type === 'text' && b.text.trim()) ||
        (b.type === 'thinking' && b.thinking.trim()),
    )
    if (hasText) {
      sequence.push({ type: 'assistant', msg: assistantMsg })
    }
    // Add tool calls from this assistant message
    const toolUseIds = new Set(
      assistantMsg.message.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => (b as { id: string }).id),
    )
    while (
      toolCallIdx < turn.toolCalls.length &&
      toolUseIds.has(turn.toolCalls[toolCallIdx].toolUse.id)
    ) {
      sequence.push({ type: 'tool', call: turn.toolCalls[toolCallIdx] })
      toolCallIdx++
    }
  }
  // Add any remaining tool calls
  while (toolCallIdx < turn.toolCalls.length) {
    sequence.push({ type: 'tool', call: turn.toolCalls[toolCallIdx] })
    toolCallIdx++
  }

  return (
    <div
      onClick={onSelect}
      className={cn(
        'px-3 py-3 sm:px-4 sm:py-4 border-b border-border/50 transition-colors',
        isSelected ? 'bg-accent/30' : 'hover:bg-accent/10',
      )}
    >
      {/* Turn header */}
      <div className="flex items-center justify-between mb-3 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="bg-muted px-1.5 py-0.5 rounded font-medium">
            Turn {turn.index + 1}
          </span>
          <span>{format(turn.startTime, 'HH:mm:ss')}</span>
        </div>
        <div className="flex items-center gap-3">
          {turn.assistantMessages.length > 0 && (
            <div className="relative">
              <button
                ref={flowBtnRef}
                onClick={(e) => {
                  e.stopPropagation()
                  setShowFlow(!showFlow)
                }}
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors',
                  showFlow
                    ? 'bg-foreground/10 text-foreground'
                    : 'hover:bg-muted text-muted-foreground hover:text-foreground',
                )}
                title="Execution Flow"
              >
                <Workflow className="w-3 h-3" />
                <span>{turn.assistantMessages.length} req</span>
              </button>
              {showFlow && <ExecutionFlowPopover ref={flowRef} turn={turn} />}
            </div>
          )}
          {turn.durationMs !== null && (
            <span>{formatDuration(turn.durationMs)}</span>
          )}
          <span>
            {formatTokenCount(
              turn.totalTokens.input_tokens + turn.totalTokens.output_tokens,
            )}{' '}
            tokens
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-3">
        <UserMessageBubble message={turn.userMessage} />

        {turn.systemMessages
          .filter((s) => s.subtype === 'local_command')
          .map((s) => (
            <LocalCommandSystemMessage key={s.uuid} msg={s} />
          ))}

        {turn.systemMessages
          .filter(
            (s) =>
              s.subtype === 'compact_boundary' ||
              s.subtype === 'microcompact_boundary',
          )
          .map((s) => (
            <div
              key={s.uuid}
              className="flex items-center gap-2 py-1 text-[10px] text-muted-foreground"
            >
              <div className="flex-1 border-t border-dashed border-amber-500/30" />
              <Scissors className="w-3 h-3 text-amber-500/60" />
              <span className="text-amber-500/80 font-medium">
                {s.subtype === 'compact_boundary'
                  ? 'Context compacted'
                  : 'Micro-compacted'}
              </span>
              <div className="flex-1 border-t border-dashed border-amber-500/30" />
            </div>
          ))}

        {sequence.map((item, idx) => {
          if (item.type === 'assistant') {
            return (
              <AssistantMessageBubble key={`a-${idx}`} message={item.msg} />
            )
          }
          return (
            <ToolCallCard
              key={`t-${item.call.toolUse.id}`}
              toolCall={item.call}
            />
          )
        })}
      </div>
    </div>
  )
}
