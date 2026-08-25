// 轻量手写 Markdown 渲染器 + memo 化的 React 组件。从 main.tsx 提取以便
// SkillsView 和通知详情窗口共用，且 markdown 解析（CPU 密集）被 useMemo 缓存。
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

function renderMarkdownInline(
  value: string,
  onOpenLink: (url: string) => void,
): ReactNode[] {
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(.+?)\*|_(.+?)_|(https?:\/\/[^\s<]+))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const fullMatch = match[0];
    const linkLabel = match[2];
    const linkURL = match[3];
    const code = match[4];
    const strong = match[5] || match[6];
    const strike = match[7];
    const emphasis = match[8] || match[9];
    const plainURL = match[10];
    if (linkLabel && linkURL) {
      nodes.push(
        <button
          className="markdownLink"
          key={`link-${key++}`}
          type="button"
          onClick={() => onOpenLink(linkURL)}
        >
          {linkLabel}
        </button>,
      );
    } else if (code) {
      nodes.push(
        <code className="markdownInlineCode" key={`code-${key++}`}>
          {code}
        </code>,
      );
    } else if (strong) {
      nodes.push(<strong key={`strong-${key++}`}>{strong}</strong>);
    } else if (strike) {
      nodes.push(<del key={`strike-${key++}`}>{strike}</del>);
    } else if (emphasis) {
      nodes.push(<em key={`emphasis-${key++}`}>{emphasis}</em>);
    } else if (plainURL) {
      const trailing = plainURL.match(/[.,!?;:]+$/)?.[0] ?? "";
      const url = trailing ? plainURL.slice(0, -trailing.length) : plainURL;
      nodes.push(
        <button
          className="markdownLink"
          key={`url-${key++}`}
          type="button"
          onClick={() => onOpenLink(url)}
        >
          {url}
        </button>,
      );
      if (trailing) nodes.push(trailing);
    } else {
      nodes.push(fullMatch);
    }
    cursor = match.index + fullMatch.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function isMarkdownBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^```/.test(line) ||
    /^~~~/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^([-*_])(?:\s*\1){2,}$/.test(line)
  );
}

function renderMarkdownBlocks(
  markdown: string,
  onOpenLink: (url: string) => void,
): ReactNode[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)\s*.*$/);
    if (fence) {
      const fenceMarker = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !lines[index].trimStart().startsWith(fenceMarker)
      ) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <pre className="markdownCodeBlock" key={`code-block-${key++}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4;
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4";
      nodes.push(
        <Heading key={`heading-${key++}`}>
          {renderMarkdownInline(heading[2], onOpenLink)}
        </Heading>,
      );
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      nodes.push(
        <blockquote key={`quote-${key++}`}>
          {renderMarkdownBlocks(quoteLines.join("\n"), onOpenLink)}
        </blockquote>,
      );
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.test(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.test(line);
    if (unordered || ordered) {
      const items: string[] = [];
      const itemPattern = ordered
        ? /^\s*\d+[.)]\s+(.+)$/
        : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(itemPattern);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      nodes.push(
        <List key={`list-${key++}`}>
          {items.map((item, itemIndex) => (
            <li key={`list-item-${itemIndex}`}>
              {renderMarkdownInline(item, onOpenLink)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      nodes.push(<hr key={`rule-${key++}`} />);
      index += 1;
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isMarkdownBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    nodes.push(
      <p key={`paragraph-${key++}`}>
        {paragraphLines.map((paragraphLine, lineIndex) => (
          <span key={`paragraph-line-${lineIndex}`}>
            {lineIndex > 0 ? <br /> : null}
            {renderMarkdownInline(paragraphLine, onOpenLink)}
          </span>
        ))}
      </p>,
    );
  }
  return nodes;
}

export const MarkdownContent = memo(
  function MarkdownContent({
    value,
    onOpenLink,
  }: {
    value: string;
    onOpenLink: (url: string) => void;
  }) {
    // markdown 解析是 CPU 密集的正则+递归，且 value 几乎不变（README/正文）。
    // 仅在 value 变化时重新解析；onOpenLink 用 ref 透传，避免父组件每次渲染
    // 传入新函数引用导致 memo 失效 + 重解析。
    const handlerRef = useRef(onOpenLink);
    handlerRef.current = onOpenLink;
    const stableOpenLink = useCallback((url: string) => {
      handlerRef.current(url);
    }, []);
    const blocks = useMemo(
      () => renderMarkdownBlocks(value, stableOpenLink),
      [value, stableOpenLink],
    );
    return <div className="markdownContent">{blocks}</div>;
  },
);
