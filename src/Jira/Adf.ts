// Atlassian Document Format (ADF) ↔ Markdown conversion utilities.
// Pure functions, no Effect dependencies.

// ---------------------------------------------------------------------------
// ADF → Markdown
// ---------------------------------------------------------------------------

interface AdfNode {
  readonly type: string
  readonly content?: ReadonlyArray<AdfNode>
  readonly text?: string
  readonly attrs?: Record<string, unknown>
  readonly marks?: ReadonlyArray<{
    type: string
    attrs?: Record<string, unknown>
  }>
}

function isAdfNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && "type" in value
}

function convertNode(node: AdfNode, listPrefix?: string): string {
  switch (node.type) {
    case "doc":
      return convertChildren(node)
        .replace(/\n{3,}/g, "\n\n")
        .trim()

    case "paragraph":
      return convertChildren(node) + "\n"

    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6)
      return "#".repeat(level) + " " + convertChildren(node) + "\n"
    }

    case "bulletList":
      return (
        (node.content ?? []).map((child) => convertNode(child, "- ")).join("") +
        "\n"
      )

    case "orderedList":
      return (
        (node.content ?? [])
          .map((child, i) => convertNode(child, `${i + 1}. `))
          .join("") + "\n"
      )

    case "listItem": {
      const inner = convertChildren(node).replace(/\n$/, "")
      return (listPrefix ?? "- ") + inner + "\n"
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? ""
      return "```" + lang + "\n" + convertChildren(node) + "\n```\n"
    }

    case "blockquote":
      return (
        convertChildren(node)
          .replace(/\n$/, "")
          .split("\n")
          .map((line) => "> " + line)
          .join("\n") + "\n"
      )

    case "text":
      return applyMarks(node.text ?? "", node.marks)

    case "hardBreak":
      return "\n"

    case "rule":
      return "---\n"

    default:
      // Unknown node – extract text content gracefully
      if (node.content) {
        return convertChildren(node)
      }
      return node.text ?? ""
  }
}

function convertChildren(node: AdfNode): string {
  return (node.content ?? []).map((child) => convertNode(child)).join("")
}

function applyMarks(
  text: string,
  marks?: ReadonlyArray<{ type: string; attrs?: Record<string, unknown> }>,
): string {
  if (!marks || marks.length === 0) return text
  let result = text
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        result = `**${result}**`
        break
      case "em":
        result = `*${result}*`
        break
      case "code":
        result = "`" + result + "`"
        break
      case "strike":
        result = `~~${result}~~`
        break
      case "link": {
        const href = (mark.attrs?.href as string) ?? ""
        result = `[${result}](${href})`
        break
      }
    }
  }
  return result
}

/**
 * Convert an Atlassian Document Format document to Markdown.
 *
 * Supports common block and inline nodes. Unknown nodes are handled
 * gracefully by extracting their text content.
 */
export function adfToMarkdown(adf: unknown): string {
  if (!isAdfNode(adf)) return ""
  return convertNode(adf)
}

// ---------------------------------------------------------------------------
// Markdown → ADF
// ---------------------------------------------------------------------------

interface AdfDocNode {
  readonly type: "doc"
  readonly version: 1
  readonly content: Array<Record<string, unknown>>
}

function textNode(
  text: string,
  marks?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const node: Record<string, unknown> = { type: "text", text }
  if (marks && marks.length > 0) {
    node.marks = marks
  }
  return node
}

function parseInline(text: string): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = []
  // Regex for inline patterns: bold, italic, code, strikethrough, links
  const regex =
    /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Add preceding plain text
    if (match.index > lastIndex) {
      nodes.push(textNode(text.slice(lastIndex, match.index)))
    }

    if (match[2] != null) {
      // **bold**
      nodes.push(textNode(match[2], [{ type: "strong" }]))
    } else if (match[3] != null) {
      // *italic*
      nodes.push(textNode(match[3], [{ type: "em" }]))
    } else if (match[4] != null) {
      // `code`
      nodes.push(textNode(match[4], [{ type: "code" }]))
    } else if (match[5] != null) {
      // ~~strike~~
      nodes.push(textNode(match[5], [{ type: "strike" }]))
    } else if (match[6] != null && match[7] != null) {
      // [text](url)
      nodes.push(
        textNode(match[6], [{ type: "link", attrs: { href: match[7] } }]),
      )
    }

    lastIndex = match.index + match[0].length
  }

  // Trailing text
  if (lastIndex < text.length) {
    nodes.push(textNode(text.slice(lastIndex)))
  }

  if (nodes.length === 0 && text.length > 0) {
    nodes.push(textNode(text))
  }

  return nodes
}

function paragraphNode(text: string): Record<string, unknown> {
  return { type: "paragraph", content: parseInline(text) }
}

/**
 * Convert Markdown to an Atlassian Document Format document.
 *
 * This is a simple line-by-line parser that supports headings, single-level
 * bullet and ordered lists, code blocks, blockquotes, and horizontal rules.
 * Unsupported constructs become plain text paragraphs. Returns a valid ADF
 * `doc` node with `version: 1`.
 */
export function markdownToAdf(markdown: string): unknown {
  const lines = markdown.split("\n")
  const content: Array<Record<string, unknown>> = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Blank line – skip
    if (line.trim() === "") {
      i++
      continue
    }

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!)
        i++
      }
      i++ // skip closing ```
      const codeContent = codeLines.join("\n")
      const node: Record<string, unknown> = {
        type: "codeBlock",
        content: codeContent ? [textNode(codeContent)] : [],
      }
      if (lang) {
        node.attrs = { language: lang }
      }
      content.push(node)
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      content.push({ type: "rule" })
      i++
      continue
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line)
    if (headingMatch) {
      content.push({
        type: "heading",
        attrs: { level: headingMatch[1]!.length },
        content: parseInline(headingMatch[2]!),
      })
      i++
      continue
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = []
      while (
        i < lines.length &&
        (lines[i]!.startsWith("> ") || lines[i] === ">")
      ) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""))
        i++
      }
      content.push({
        type: "blockquote",
        content: [paragraphNode(quoteLines.join("\n"))],
      })
      continue
    }

    // Bullet list
    if (/^[-*+]\s/.test(line)) {
      const items: Array<Record<string, unknown>> = []
      while (i < lines.length && /^[-*+]\s/.test(lines[i]!)) {
        items.push({
          type: "listItem",
          content: [paragraphNode(lines[i]!.replace(/^[-*+]\s/, ""))],
        })
        i++
      }
      content.push({ type: "bulletList", content: items })
      continue
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: Array<Record<string, unknown>> = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i]!)) {
        items.push({
          type: "listItem",
          content: [paragraphNode(lines[i]!.replace(/^\d+\.\s/, ""))],
        })
        i++
      }
      content.push({ type: "orderedList", content: items })
      continue
    }

    // Default: paragraph
    content.push(paragraphNode(line))
    i++
  }

  const doc: AdfDocNode = {
    type: "doc",
    version: 1,
    content,
  }

  return doc
}
