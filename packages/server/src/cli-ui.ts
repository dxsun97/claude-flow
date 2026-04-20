// Terminal UI utilities — colors, spinner, formatting helpers.
// Zero dependencies. Respects NO_COLOR and non-TTY environments.

import { spawn } from 'child_process'
import { formatTokenCount, formatBytes } from '@ccflow/shared'

export { formatTokenCount, formatBytes }

const isTTY = !!process.stdout.isTTY
const enabled = isTTY && !process.env.NO_COLOR

function fmt(open: string, close: string) {
  return enabled ? (s: string) => `${open}${s}${close}` : (s: string) => s
}

export const bold = fmt('\x1b[1m', '\x1b[22m')
export const dim = fmt('\x1b[2m', '\x1b[22m')
export const underline = fmt('\x1b[4m', '\x1b[24m')
export const red = fmt('\x1b[31m', '\x1b[39m')
export const green = fmt('\x1b[32m', '\x1b[39m')
export const yellow = fmt('\x1b[33m', '\x1b[39m')
export const cyan = fmt('\x1b[36m', '\x1b[39m')
export const gray = fmt('\x1b[90m', '\x1b[39m')

export function link(url: string): string {
  if (!enabled) return url
  return `\x1b]8;;${url}\x07${underline(cyan(url))}\x1b]8;;\x07`
}

// --- Spinner ---

const FRAMES =
  process.platform === 'win32'
    ? ['|', '/', '-', '\\']
    : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function createSpinner(message: string) {
  let i = 0
  let timer: ReturnType<typeof setInterval> | null = null

  return {
    start() {
      if (!isTTY) {
        process.stderr.write(message + '\n')
        return
      }
      timer = setInterval(() => {
        process.stderr.write(
          `\r  ${cyan(FRAMES[i++ % FRAMES.length])} ${message}`,
        )
      }, 80)
    },
    stop(finalMessage: string) {
      if (timer) clearInterval(timer)
      if (isTTY) process.stderr.write('\r\x1b[2K')
      process.stderr.write(finalMessage + '\n')
    },
  }
}

// --- Banner ---

export function printBanner(version: string) {
  console.log()
  console.log(`  ${bold('ccflow')} ${dim(`v${version}`)}`)
  console.log(`  ${dim('Dashboard for Claude Code sessions')}`)
  console.log()
}

// --- Formatting helpers ---

export function formatRelativeTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/** ANSI-aware padEnd — strips escape sequences for length calculation */
export function padEnd(s: string, len: number): string {
  const visible = s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\]8;;[^\x07]*\x07/g, '')
  return s + ' '.repeat(Math.max(0, len - visible.length))
}

/** Truncate a string to maxLen, adding ellipsis if needed */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '\u2026'
}

/** Simple horizontal bar using block characters */
export function bar(value: number, max: number, width: number): string {
  if (max === 0) return ''
  const filled = Math.round((value / max) * width)
  return cyan('\u2588'.repeat(filled)) + dim('\u2591'.repeat(width - filled))
}

/**
 * Pipe text through the system pager (less -R) when it exceeds terminal height.
 * Falls back to direct output in non-TTY or when pager is unavailable.
 */
export function paged(text: string): Promise<void> {
  if (!isTTY) {
    process.stdout.write(text)
    return Promise.resolve()
  }

  const termHeight = process.stdout.rows || 24
  const lineCount = text.split('\n').length

  if (lineCount <= termHeight) {
    process.stdout.write(text)
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const pagerCmd = process.env.PAGER || (isWin ? 'more' : 'less')
    const pagerArgs = pagerCmd === 'less' ? ['-R'] : []
    const child = spawn(pagerCmd, pagerArgs, {
      stdio: ['pipe', 'inherit', 'inherit'],
      ...(isWin && { shell: true }), // `more` on Windows needs shell
    })

    child.on('error', () => {
      // Pager not found — fall back to direct output
      process.stdout.write(text)
      resolve()
    })

    child.on('close', () => resolve())
    child.stdin.write(text)
    child.stdin.end()
  })
}
