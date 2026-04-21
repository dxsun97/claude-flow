// CLI subcommand implementations.
// Imports data functions from server.ts and formatting from cli-ui.ts.

import fs from 'fs'
import os from 'os'
import type { ProjectInfo } from '@ccsight/shared'
import {
  loadConfig,
  scanSource,
  computeDashboardStats,
  CONFIG_PATH,
  DEFAULT_SOURCES,
  saveConfig,
} from './server.js'
import {
  bold,
  dim,
  cyan,
  green,
  yellow,
  red,
  gray,
  formatTokenCount,
  formatRelativeTime,
  truncate,
  padEnd,
  bar,
  paged,
} from './cli-ui.js'

// --- sessions / ls ---

export async function sessionsCommand() {
  const config = loadConfig()
  const allProjects: ProjectInfo[] = []
  for (const source of config.dataSources) {
    allProjects.push(...scanSource(source))
  }

  const allSessions: {
    time: string
    projectPath: string
    label: string
    id: string
  }[] = []

  for (const project of allProjects) {
    for (const session of project.sessions) {
      allSessions.push({
        time: session.modified,
        projectPath: project.projectPath,
        label: session.title || session.preview || session.id,
        id: session.id,
      })
    }
  }

  allSessions.sort((a, b) => b.time.localeCompare(a.time))

  if (allSessions.length === 0) {
    console.log(`\n  ${dim('No sessions found.')}\n`)
    return
  }

  const cols = process.stdout.columns || 80
  const timeCol = 10
  const idCol = 10
  const gap = 4
  const remaining = cols - timeCol - idCol - gap - 4
  const pathCol = Math.max(16, Math.floor(remaining * 0.4))
  const labelCol = Math.max(16, remaining - pathCol - 2)

  const lines: string[] = []
  lines.push('')
  lines.push(`  ${bold('Recent Sessions')}`)
  lines.push('')

  for (const s of allSessions) {
    const time = padEnd(dim(formatRelativeTime(s.time)), timeCol)
    const projPath = padEnd(
      truncate(s.projectPath.replace(os.homedir(), '~'), pathCol),
      pathCol,
    )
    const label = padEnd(truncate(s.label, labelCol), labelCol)
    const id = gray(s.id.slice(0, 8))
    lines.push(`  ${time}  ${projPath}  ${label}  ${id}`)
  }

  const totalProjects = allProjects.length
  const totalSessions = allSessions.length
  lines.push('')
  lines.push(
    `  ${dim(`${totalSessions} session${totalSessions === 1 ? '' : 's'} across ${totalProjects} project${totalProjects === 1 ? '' : 's'}`)}`,
  )
  lines.push('')

  await paged(lines.join('\n'))
}

// --- stats ---

export function statsCommand() {
  const stats = computeDashboardStats()

  console.log(`\n  ${bold('Stats')}\n`)

  // Projects & sessions
  console.log(
    `  ${dim('Projects')}    ${bold(String(stats.totalProjects))}          ${dim('Sessions')}    ${bold(String(stats.totalSessions))}`,
  )
  console.log()

  // Token usage
  const t = stats.tokenUsage
  console.log(`  ${bold('Tokens')}`)
  console.log(
    `    ${dim('Input')}        ${padEnd(cyan(formatTokenCount(t.input_tokens)), 12)} ${dim('Output')}       ${cyan(formatTokenCount(t.output_tokens))}`,
  )
  console.log(
    `    ${dim('Cache read')}   ${padEnd(cyan(formatTokenCount(t.cache_read_input_tokens)), 12)} ${dim('Cache write')}  ${cyan(formatTokenCount(t.cache_creation_input_tokens))}`,
  )
  console.log()

  // Activity chart (last 7 days)
  const days = stats.sessionsPerDay.slice(-7)
  if (days.length > 0) {
    const max = Math.max(...days.map((d) => d.count))
    const barWidth = Math.min(30, (process.stdout.columns || 80) - 24)

    console.log(`  ${bold('Activity')} ${dim('(last 7 days)')}`)
    for (const d of days) {
      const dateLabel = d.date.slice(5) // MM-DD
      const countStr = String(d.count)
      console.log(
        `    ${dim(dateLabel)}  ${bar(d.count, max, barWidth)}  ${countStr}`,
      )
    }
    console.log()
  }
}

// --- config ---

export function configCommand(options: { showPath: boolean; reset: boolean }) {
  if (options.showPath) {
    // Raw path for scripting: $EDITOR $(ccsight config --path)
    console.log(CONFIG_PATH)
    return
  }

  if (options.reset) {
    saveConfig({ dataSources: DEFAULT_SOURCES })
    console.log(`\n  ${green('\u2713')} Config reset to defaults`)
    console.log(`  ${dim(CONFIG_PATH)}\n`)
    return
  }

  const config = loadConfig()
  const exists = fs.existsSync(CONFIG_PATH)

  console.log(
    `\n  ${bold('Config')}  ${dim(CONFIG_PATH)}${!exists ? `  ${yellow('(not created yet)')}` : ''}\n`,
  )
  console.log(`  ${bold('Data Sources')}`)

  for (const source of config.dataSources) {
    const status = source.enabled ? green('enabled') : dim('disabled')
    const pathExists = fs.existsSync(source.path)
    const pathNote = pathExists ? '' : `  ${red('(path not found)')}`
    console.log(
      `    [${status}]  ${bold(source.label)}  ${dim(source.path)}${pathNote}`,
    )
  }

  console.log()
}
