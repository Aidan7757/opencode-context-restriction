import z from "zod"
import { createReadStream } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import { createInterface } from "readline"
import { spawn } from "child_process" // Node.js built in way to run an external program as a subprocess (go binary)
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { InstructionPrompt } from "../session/instruction"
import { Filesystem } from "../util/filesystem"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file or directory to read"),
    offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
    limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
  }),
  async execute(params, ctx) {
    if (params.offset !== undefined && params.offset < 1) {
      throw new Error("offset must be greater than or equal to 1")
    }
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    const stat = Filesystem.stat(filepath)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
      kind: stat?.isDirectory() ? "directory" : "file",
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    if (!stat) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const suggestions = await fs
        .readdir(dir)
        .then((entries) =>
          entries
            .filter(
              (entry) =>
                entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
            )
            .map((entry) => path.join(dir, entry))
            .slice(0, 3),
        )
        .catch(() => [])

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    if (stat.isDirectory()) {
      const dirents = await fs.readdir(filepath, { withFileTypes: true })
      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          if (dirent.isDirectory()) return dirent.name + "/"
          if (dirent.isSymbolicLink()) {
            const target = await fs.stat(path.join(filepath, dirent.name)).catch(() => undefined)
            if (target?.isDirectory()) return dirent.name + "/"
          }
          return dirent.name
        }),
      )
      entries.sort((a, b) => a.localeCompare(b))

      const limit = params.limit ?? DEFAULT_READ_LIMIT
      const offset = params.offset ?? 1
      const start = offset - 1
      const sliced = entries.slice(start, start + limit)
      const truncated = start + sliced.length < entries.length

      const output = [
        `<path>${filepath}</path>`,
        `<type>directory</type>`,
        `<entries>`,
        sliced.join("\n"),
        truncated
          ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
          : `\n(${entries.length} entries)`,
        `</entries>`,
      ].join("\n")

      return {
        title,
        output,
        metadata: {
          preview: sliced.slice(0, 20).join("\n"),
          truncated,
          loaded: [] as string[],
        },
      }
    }

    const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const mime = Filesystem.mimeType(filepath)
    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
    const isPdf = mime === "application/pdf"
    if (isImage || isPdf) {
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
          loaded: instructions.map((i) => i.filepath),
        },
        attachments: [
          {
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(filepath)).toString("base64")}`,
          },
        ],
      }
    }

    const isBinary = await isBinaryFile(filepath, Number(stat.size))
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const stream = createReadStream(filepath, { encoding: "utf8" })
    const rl = createInterface({
      input: stream,
      // Note: we use the crlfDelay option to recognize all instances of CR LF
      // ('\r\n') in file as a single line break.
      crlfDelay: Infinity,
    })

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset ?? 1
    const start = offset - 1
    const raw: string[] = []
    let bytes = 0
    let lines = 0
    let truncatedByBytes = false
    let hasMoreLines = false
    try {
      for await (const text of rl) {
        lines += 1
        if (lines <= start) continue

        if (raw.length >= limit) {
          hasMoreLines = true
          continue
        }

        const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
        const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          truncatedByBytes = true
          hasMoreLines = true
          break
        }

        raw.push(line)
        bytes += size
      }
    } finally {
      rl.close()
      stream.destroy()
    }

    if (lines < offset && !(lines === 0 && offset === 1)) {
      throw new Error(`Offset ${offset} is out of range for this file (${lines} lines)`)
    }

    const content = raw.map((line, index) => {
      return `${index + offset}: ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    // this is the point where the file has been read into memory, but before opencode forms the output string for the llm. (comes this late because the preview variable is essential)
    // calling runContextParser with the filepath. if the file has tags it returns a filtered string and we return that to the llm and skip the rest, if the parser returns null (no tags, binary not set, other error) the execution pivots back to the original code. 
    const parsedOutput = await runContextParser(filepath, instructions)
    if (parsedOutput !== null) {
      return {
        title,
        output: parsedOutput,
        metadata: {
          preview,
          truncated: false,
          loaded: instructions.map((i) => i.filepath),
        },
      }
    }

    let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>"].join("\n")
    output += content.join("\n")

    const totalLines = lines
    const lastReadLine = offset + raw.length - 1
    const nextOffset = lastReadLine + 1
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`
    } else if (hasMoreLines) {
      output += `\n\n(Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</content>"

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    if (instructions.length > 0) {
      output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
    }

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        loaded: instructions.map((i) => i.filepath),
      },
    }
  },
})

// Component shape returned by the individual-component parser.
interface IndividualComponent {
  Body: string
  Description: string
  Filename: string
}

// seperate function to keep execution logic clean, bridges parser and opencode. has many "quick exit" points where it returns null if certain conditions are not met, which signals to the main execution function to pivot back to the original file reading logic instead of using the parsed output.

// Runs the  individual-component parser binary on a single file.
// Returns a formatted string of tagged components for the LLM, or null if:
//   - CONTEXT_PARSER_BIN env var is not set
//   - the binary is not executable / not found
//   - the file contains no tags
async function runContextParser(
  filepath: string,
  instructions: { filepath: string; content: string }[],
): Promise<string | null> {
  const bin = process.env.CONTEXT_PARSER_BIN  // reads env var, have to return null if not found (quick exit)
  if (!bin) return null

  return new Promise((resolve) => {
    const proc = spawn(bin, [filepath], { stdio: ["ignore", "pipe", "pipe"] }) // spawn the go binary, ignore stdin and pipe back stdout stderr
    let stdout = ""
    let stderr = ""

    // collects stdout and stderr from the binary as it runs
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on("error", () => resolve(null)) // binary not found or executable (quick exit)
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null) // binary found but returned an error code (quick exit)

      let parsed: Record<string, Record<string, IndividualComponent>>
      try {
        parsed = JSON.parse(stdout) // checks if json in stdout (from binary) is valid, if it is not it returns null (quick exit)
      } catch {
        return resolve(null)
      }

      const components = parsed[filepath]
      if (!components || Object.keys(components).length === 0) return resolve(null) // if no tags in file, return null (quick exit)
      
      // actually builds the output string for the llm, which includes the original filepath, a type tag, and then each component found in the file with its own tags and description if provided. also includes any relevant instructions at the end (same "system-reminder" logic original code uses).

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>"].join("\n")
      for (const [name, comp] of Object.entries(components)) {
        const header = comp.Description
          ? `[component: ${name}, description: "${comp.Description}"]`
          : `[component: ${name}]`
        output += `\n${header}\n${comp.Body}\n`
      }
      output += `\n(${Object.keys(components).length} component(s) extracted — untagged lines omitted)`
      output += "\n</content>"

      if (instructions.length > 0) {
        output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
      }

      resolve(output)
    })
  })
}

async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  if (fileSize === 0) return false

  const fh = await fs.open(filepath, "r")
  try {
    const sampleSize = Math.min(4096, fileSize)
    const bytes = Buffer.alloc(sampleSize)
    const result = await fh.read(bytes, 0, sampleSize, 0)
    if (result.bytesRead === 0) return false

    let nonPrintableCount = 0
    for (let i = 0; i < result.bytesRead; i++) {
      if (bytes[i] === 0) return true
      if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
        nonPrintableCount++
      }
    }
    // If >30% non-printable characters, consider it binary
    return nonPrintableCount / result.bytesRead > 0.3
  } finally {
    await fh.close()
  }
}
