#!/usr/bin/env node

import path from 'path'
import fs from 'fs'
import { exec } from 'child_process'
import { startServer, MAX_PORT_RETRIES } from './server.js'
import { loadConfig, scanSource } from './server.js'
import {
  bold,
  dim,
  red,
  green,
  cyan,
  link,
  createSpinner,
  printBanner,
} from './cli-ui.js'
import { sessionsCommand, statsCommand, configCommand } from './cli-commands.js'

// --- Version ---

function getVersion(): string {
  // When compiled: dist/cli.js -> look for root package.json at ../../..
  // (packages/server/dist/cli.js -> package.json)
  const candidates = [
    path.join(import.meta.dirname, '..', '..', '..', 'package.json'),
    path.join(import.meta.dirname, '..', 'package.json'),
    path.join(import.meta.dirname, 'package.json'),
  ]
  for (const pkgPath of candidates) {
    if (fs.existsSync(pkgPath)) {
      try {
        return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0'
      } catch {
        /* skip */
      }
    }
  }
  return '0.0.0'
}

// --- Arg parsing ---

const args = process.argv.slice(2)

const KNOWN_FLAGS = new Set([
  '--port',
  '--no-open',
  '-h',
  '--help',
  '-v',
  '--version',
  '--path',
  '--reset',
])

const SUBCOMMANDS = new Set(['sessions', 'ls', 'stats', 'config'])

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
  return undefined
}

function hasFlag(flag: string): boolean {
  return args.includes(flag)
}

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  )
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

function suggestFlag(unknown: string): string | null {
  let best = '',
    bestDist = Infinity
  for (const known of KNOWN_FLAGS) {
    const d = levenshtein(unknown, known)
    if (d < bestDist) {
      bestDist = d
      best = known
    }
  }
  return bestDist <= 3 ? best : null
}

// --- Validate unknown flags ---

for (const arg of args) {
  if (arg.startsWith('-') && !KNOWN_FLAGS.has(arg)) {
    // Skip values that follow a known flag (e.g., "3179" after "--port")
    const idx = args.indexOf(arg)
    if (
      idx > 0 &&
      KNOWN_FLAGS.has(args[idx - 1]) &&
      !args[idx - 1].startsWith('--no-')
    )
      continue

    const suggestion = suggestFlag(arg)
    console.error(`\n  ${red('Error:')} Unknown flag ${bold(arg)}`)
    if (suggestion) {
      console.error(`  Did you mean ${cyan(suggestion)}?`)
    }
    console.error()
    process.exit(1)
  }
}

// --- Help ---

function printHelp() {
  const v = getVersion()
  console.log(`
  ${bold('ccsight')} ${dim(`v${v}`)} — Dashboard for Claude Code sessions

  ${bold('Usage:')} ccsight [command] [options]

  ${bold('Commands:')}
    ${cyan('serve')}       Start the dashboard server ${dim('(default)')}
    ${cyan('sessions')}    List recent sessions
    ${cyan('stats')}       Show token usage summary
    ${cyan('config')}      Show/manage configuration

  ${bold('Server Options:')}
    --port <n>    Port to run on ${dim('(default: 3179)')}
    --no-open     Don't auto-open the browser

  ${bold('Config Options:')}
    --path        Print config file path
    --reset       Reset config to defaults

  ${bold('General:')}
    -h, --help    Show this help
    -v, --version Show version

  ${bold('Examples:')}
    ${dim('$')} ccsight                    ${dim('Start dashboard on default port')}
    ${dim('$')} ccsight --port 8080        ${dim('Start on custom port')}
    ${dim('$')} ccsight sessions           ${dim('List recent sessions')}
    ${dim('$')} ccsight stats              ${dim('Show token usage')}
    ${dim('$')} ccsight config --path      ${dim('Print config file path')}
`)
}

if (hasFlag('-h') || hasFlag('--help')) {
  printHelp()
  process.exit(0)
}

if (hasFlag('-v') || hasFlag('--version')) {
  console.log(getVersion())
  process.exit(0)
}

// --- Port validation ---

function validatePort(value: string): number {
  const port = parseInt(value, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(
      `\n  ${red('Error:')} Invalid port ${bold(`"${value}"`)}. Must be 1\u201365535.\n`,
    )
    process.exit(1)
  }
  return port
}

// Detect --port at end of args with no value
if (hasFlag('--port') && getArg('--port') === undefined) {
  console.error(`\n  ${red('Error:')} ${bold('--port')} requires a number.\n`)
  process.exit(1)
}

// --- Determine command ---

const command = args.find((a) => SUBCOMMANDS.has(a)) ?? 'serve'

// --- Graceful shutdown ---

process.on('SIGINT', () => {
  console.log(dim('\n  Stopped.'))
  process.exit(0)
})

// --- Dispatch ---

switch (command) {
  case 'sessions':
  case 'ls': {
    await sessionsCommand()
    break
  }

  case 'stats': {
    statsCommand()
    break
  }

  case 'config': {
    configCommand({
      showPath: hasFlag('--path'),
      reset: hasFlag('--reset'),
    })
    break
  }

  default: {
    // --- Serve command ---
    const port = validatePort(getArg('--port') ?? '3179')
    const noOpen = hasFlag('--no-open')
    const version = getVersion()

    // Resolve dist path — look for web package's dist
    let distPath = path.join(import.meta.dirname, '..', '..', 'web', 'dist')
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      // Fallback for development (running from packages/server/src via tsx)
      distPath = path.join(import.meta.dirname, '..', '..', 'web', 'dist')
    }
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      // Legacy fallback
      distPath = path.join(import.meta.dirname, 'dist')
    }
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      distPath = path.join(import.meta.dirname, '..', 'dist')
    }
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      console.error(`\n  ${red('Error:')} Frontend build not found.`)
      console.error(
        `  Run ${cyan('pnpm build')} first, or reinstall the package.\n`,
      )
      process.exit(1)
    }

    printBanner(version)

    const spinner = createSpinner('Starting server...')
    spinner.start()

    startServer({ port, distPath })
      .then(({ port: actualPort }) => {
        const url = `http://localhost:${actualPort}`

        // Count projects/sessions for the startup summary
        let totalProjects = 0
        let totalSessions = 0
        try {
          const config = loadConfig()
          for (const source of config.dataSources) {
            const projects = scanSource(source)
            totalProjects += projects.length
            for (const p of projects) totalSessions += p.sessions.length
          }
        } catch {
          /* skip count on error */
        }

        spinner.stop(`  ${green('\u2713')} Server ready`)
        console.log()
        console.log(`  ${bold('URL')}        ${link(url)}`)
        if (actualPort !== port) {
          console.log(
            `  ${bold('Note')}       Port ${port} was in use, using ${cyan(String(actualPort))} instead`,
          )
        }
        if (totalProjects > 0) {
          console.log(
            `  ${bold('Data')}       ${cyan(String(totalProjects))} projects, ${cyan(String(totalSessions))} sessions`,
          )
        }
        console.log()
        console.log(`  ${dim('Press Ctrl+C to stop')}`)
        console.log()

        if (!noOpen) {
          const cmd =
            process.platform === 'darwin'
              ? `open "${url}"`
              : process.platform === 'win32'
                ? `start "" "${url}"`
                : `xdg-open "${url}"`
          exec(cmd, () => {
            /* ignore errors */
          })
        }
      })
      .catch((err: NodeJS.ErrnoException) => {
        spinner.stop(`  ${red('\u2717')} Failed to start`)
        console.log()
        if (err.code === 'EADDRINUSE') {
          console.error(
            `  ${red('Error:')} Ports ${bold(String(port))}\u2013${bold(String(port + MAX_PORT_RETRIES))} are all in use.`,
          )
          console.error(
            `  ${dim('Try:')} ${cyan(`ccsight --port ${port + MAX_PORT_RETRIES + 1}`)}`,
          )
        } else {
          console.error(`  ${red('Error:')} ${err.message}`)
        }
        console.log()
        process.exit(1)
      })
  }
}
