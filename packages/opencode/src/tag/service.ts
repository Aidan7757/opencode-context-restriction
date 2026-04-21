import chokidar from "chokidar"
import path from "path"

export type Tag = {
  name: string
  body: string
  description: string
  startOffset: number
  endOffset: number
  filename: string
}

// Matches the JSON output of the caki/individual parser binary.
type RawComponent = {
  Body: string
  Description: string
  StartOffset: number
  EndOffset: number
  Filename: string
}

type ParseResult = Record<string, Record<string, RawComponent>>

export namespace TagService {
  let _tags: Map<string, Tag> = new Map()
  let _selected: Set<string> = new Set()
  let _listeners: Set<() => void> = new Set()
  let _projectDir: string | null = null
  let _debounceTimer: NodeJS.Timeout | null = null

  function notify() {
    for (const cb of _listeners) cb()
  }

  // Subscribe to tag state changes. Returns an unsubscribe function.
  export function onChange(cb: () => void): () => void {
    _listeners.add(cb)
    return () => _listeners.delete(cb)
  }

  export function getAll(): Tag[] {
    return Array.from(_tags.values())
  }

  export function getSelected(): Tag[] {
    return Array.from(_selected).flatMap((name) => {
      const tag = _tags.get(name)
      return tag ? [tag] : []
    })
  }

  export function isSelected(name: string): boolean {
    return _selected.has(name)
  }

  export function toggle(name: string): void {
    if (_selected.has(name)) {
      _selected.delete(name)
    } else {
      _selected.add(name)
    }
    notify()
  }

  export function setSelected(names: string[]): void {
    _selected = new Set(names.filter((n) => _tags.has(n)))
    notify()
  }

  // Format selected tags as an XML context block for injection into system prompt.
  export function getContext(): string {
    const selectedTags = getSelected()
    if (selectedTags.length === 0) return ""

    const components = selectedTags
      .map((tag) => {
        const relPath = _projectDir ? path.relative(_projectDir, tag.filename) : tag.filename
        const descAttr = tag.description ? ` description="${tag.description}"` : ""
        return `<component name="${tag.name}" file="${relPath}"${descAttr}>\n${tag.body}\n</component>`
      })
      .join("\n\n")

    return [
      "<caki-context>",
      "The following code components are selected as context for this conversation.",
      "Use this context as the authoritative source for the code it covers — prefer it over reading those files again.",
      "",
      components,
      "</caki-context>",
    ].join("\n")
  }

  function dbg(msg: string) {
    try {
      const fs = require("fs") as typeof import("fs")
      fs.appendFileSync("/tmp/caki-debug.log", msg + "\n")
    } catch {}
  }

  async function runParser(dir: string): Promise<void> {
    const parserPath = process.env.CAKI_PARSER_PATH
    dbg(`[caki] runParser dir=${dir} parserPath=${parserPath}`)
    if (!parserPath) return

    try {
      const proc = Bun.spawn([parserPath, dir], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      dbg(`[caki] stdout length=${stdout.length} stderr=${stderr.slice(0, 200)}`)

      if (!stdout.trim()) {
        _tags = new Map()
        dbg("[caki] stdout empty, no tags")
        return
      }

      const result: ParseResult = JSON.parse(stdout)
      _tags = new Map()

      for (const [filepath, components] of Object.entries(result)) {
        for (const [tagName, comp] of Object.entries(components)) {
          _tags.set(tagName, {
            name: tagName,
            body: comp.Body,
            description: comp.Description,
            startOffset: comp.StartOffset,
            endOffset: comp.EndOffset,
            filename: comp.Filename || filepath,
          })
        }
      }

      dbg(`[caki] parsed ${_tags.size} tags`)

      // Prune selected tags that no longer exist after re-parse.
      for (const name of _selected) {
        if (!_tags.has(name)) _selected.delete(name)
      }
    } catch (e) {
      dbg(`[caki] parser error: ${e}`)
    }
  }

  function scheduleReparse() {
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(async () => {
      if (!_projectDir) return
      await runParser(_projectDir)
      notify()
    }, 500)
  }

  // Initialize the tag service: parse the given directory and watch for changes.
  // Safe to call multiple times; subsequent calls reset state.
  export async function init(dir: string): Promise<void> {
    _projectDir = dir
    _tags = new Map()
    _selected = new Set()

    const parserPath = process.env.CAKI_PARSER_PATH
    dbg(`[caki] init dir=${dir} parserPath=${parserPath} cwd=${process.cwd()}`)
    if (!parserPath) {
      dbg("[caki] CAKI_PARSER_PATH not set; tag parsing disabled")
      return
    }

    await runParser(dir)
    dbg(`[caki] init done, notifying ${_listeners.size} listeners, tags=${_tags.size}`)
    notify()

    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      persistent: false,
      ignored: /(^|[/\\])\../, // skip hidden files/directories
    })

    watcher.on("change", scheduleReparse)
    watcher.on("add", scheduleReparse)
    watcher.on("unlink", scheduleReparse)
  }
}
