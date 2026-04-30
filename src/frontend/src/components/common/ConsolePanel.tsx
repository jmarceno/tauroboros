/**
 * ConsolePanel Component - Embedded terminal for the bottom panel
 * Uses xterm.js for full terminal emulation
 */

import { onMount, onCleanup, createSignal } from 'solid-js'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export default function ConsolePanel() {
  let terminalRef: HTMLDivElement | undefined
  let terminal: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let ws: WebSocket | null = null
  const [isConnected, setIsConnected] = createSignal(false)

  onMount(() => {
    if (!terminalRef) return

    // Initialize xterm.js terminal
    terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 12,
      fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, Consolas, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        selectionBackground: '#388bfd',
        black: '#010409',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#f778ba',
        cyan: '#56d4dd',
        white: '#e6edf3',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#f088b8',
        brightCyan: '#56d4dd',
        brightWhite: '#ffffff',
      },
      scrollback: 5000,
      allowProposedApi: true,
    })

    // Add addons
    fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())

    // Open terminal in the container
    terminal.open(terminalRef)
    fitAddon.fit()

    // Connect to WebSocket for shell access
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/console`

    try {
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        setIsConnected(true)
      }

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'output' && data.data) {
          // Decode base64 output and write to terminal
          const decoded = atob(data.data)
          terminal?.write(decoded)
        } else if (data.type === 'error') {
          terminal?.writeln(`\r\n\x1b[31mError: ${data.message}\x1b[0m`)
        } else if (data.type === 'status') {
          if (data.status === 'ready') {
            terminal?.writeln(`\r\n\x1b[32mShell ready: ${data.shell}\x1b[0m\r\n`)
          }
        }
      }

      ws.onerror = () => {
        setIsConnected(false)
        terminal?.writeln('\r\n\x1b[31m✗ Connection error\x1b[0m')
      }

      ws.onclose = () => {
        setIsConnected(false)
        terminal?.writeln('\r\n\x1b[33m✗ Disconnected from shell\x1b[0m')
      }

      // Send input from terminal to WebSocket
      terminal.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: btoa(data) }))
        }
      })

      // Handle resize - using ResizeObserver to detect container size changes
      let resizeTimeout: ReturnType<typeof setTimeout> | null = null
      
      const handleResize = () => {
        if (!fitAddon || !terminal) return
        
        fitAddon.fit()
        if (ws?.readyState === WebSocket.OPEN) {
          const dims = { cols: terminal.cols, rows: terminal.rows }
          ws.send(JSON.stringify({ type: 'resize', ...dims }))
        }
      }

      // Use ResizeObserver to detect container size changes (for panel resize)
      let resizeObserver: ResizeObserver | null = null
      if (terminalRef && 'ResizeObserver' in window) {
        resizeObserver = new ResizeObserver((entries) => {
          // Debounce resize to avoid too many resize messages during drag
          if (resizeTimeout) clearTimeout(resizeTimeout)
          resizeTimeout = setTimeout(() => {
            handleResize()
          }, 50) // 50ms debounce - updates shortly after resize stops
        })
        resizeObserver.observe(terminalRef)
      }

      // Also listen for window resize as fallback
      window.addEventListener('resize', handleResize)

      onCleanup(() => {
        window.removeEventListener('resize', handleResize)
        if (resizeObserver && terminalRef) {
          resizeObserver.unobserve(terminalRef)
        }
        if (resizeTimeout) clearTimeout(resizeTimeout)
      })

      // Initial resize after mount
      setTimeout(handleResize, 100)

    } catch (err) {
      console.error('Failed to initialize console:', err)
    }
  })

  onCleanup(() => {
    ws?.close()
    terminal?.dispose()
  })

  return (
    <div class="h-full flex flex-col">
      {/* Simple status bar */}
      <div class="flex items-center justify-between px-3 py-1 bg-dark-surface border-b border-dark-border">
        <div class="flex items-center gap-2">
          <span
            class={`inline-block w-2 h-2 rounded-full ${
              isConnected() ? 'bg-green-500' : 'bg-red-500'
            }`}
            title={isConnected() ? 'Connected' : 'Disconnected'}
          />
          <span class="text-xs text-dark-text-muted">
            {isConnected() ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <button
          onClick={() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.close()
            }
            // Reconnect
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const wsUrl = `${protocol}//${window.location.host}/console`
            ws = new WebSocket(wsUrl)
            setIsConnected(false)
          }}
          class="px-2 py-0.5 text-[10px] text-dark-text-muted hover:text-dark-text bg-dark-surface-hover hover:bg-dark-border-hover rounded transition-colors"
          disabled={isConnected()}
        >
          {isConnected() ? '●' : 'Reconnect'}
        </button>
      </div>

      {/* Terminal container */}
      <div class="flex-1 p-2 overflow-hidden">
        <div
          ref={terminalRef}
          class="h-full w-full"
        />
      </div>
    </div>
  )
}
