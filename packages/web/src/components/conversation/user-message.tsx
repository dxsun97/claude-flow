import { User, Terminal, Bell } from 'lucide-react'
import type { UserTextMessage } from '@/types/session'

interface UserMessageProps {
  message: UserTextMessage
}

function extractTag(content: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  return re.exec(content)?.[1]?.trim() ?? ''
}

function isLocalCommand(content: string): boolean {
  return (
    content.startsWith('<command-name>') ||
    content.startsWith('<local-command-caveat>') ||
    content.startsWith('<local-command-stdout>')
  )
}

function isTaskNotification(message: UserTextMessage): boolean {
  return message.origin?.kind === 'task-notification'
}

/** Strip ANSI escape sequences for display */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function LocalCommandBubble({ content }: { content: string }) {
  const commandName = extractTag(content, 'command-name')
  const stdout = stripAnsi(extractTag(content, 'local-command-stdout'))

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
          {!commandName && !stdout && (
            <span className="text-xs text-muted-foreground italic">
              No output
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskNotificationBubble({ content }: { content: string }) {
  const summary = extractTag(content, 'summary')
  const status = extractTag(content, 'status')
  const taskId = extractTag(content, 'task-id')

  const isSuccess = status === 'completed'

  return (
    <div className="flex gap-3 items-start">
      <div className="w-7 h-7 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
        <Bell className="w-3.5 h-3.5 text-amber-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">
          Task Notification
        </div>
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            {status && (
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${isSuccess ? 'bg-green-500/15 text-green-500' : 'bg-muted text-muted-foreground'}`}
              >
                {status}
              </span>
            )}
            {taskId && (
              <code className="text-[10px] text-muted-foreground">
                {taskId}
              </code>
            )}
          </div>
          {summary && <p className="mt-1 text-sm">{summary}</p>}
        </div>
      </div>
    </div>
  )
}

export function UserMessageBubble({ message }: UserMessageProps) {
  const content = message.message.content

  if (isTaskNotification(message)) {
    return <TaskNotificationBubble content={content} />
  }

  if (isLocalCommand(content)) {
    return <LocalCommandBubble content={content} />
  }

  return (
    <div className="flex gap-3 items-start">
      <div className="w-7 h-7 rounded-full bg-tool-agent/20 flex items-center justify-center shrink-0 mt-0.5">
        <User className="w-3.5 h-3.5 text-tool-agent" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">You</div>
        <div className="bg-tool-agent/10 border border-tool-agent/20 rounded-lg rounded-tl-sm px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {content}
        </div>
      </div>
    </div>
  )
}
