import { useMemo, useState, type ReactNode } from "react";
import { IconCheck, IconCopy } from "./icons.tsx";

/**
 * 轻量 Markdown 渲染器。
 *
 * 为什么不引第三方库：
 *   1. 离线/不出网环境下不新增运行时依赖；
 *   2. 逐行解析为 React 元素、不做 dangerouslySetInnerHTML —— 天然免疫 XSS。
 *
 * 覆盖 coding agent 输出的常见语法：标题 / 代码块 / 行内代码 / 有序无序列表 /
 * 引用 / 表格 / 链接 / 粗体 / 斜体 / 删除线 / 分割线。
 */

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const key = `${keyBase}-i${i++}`;

    if (t.startsWith("**") || t.startsWith("__")) {
      out.push(<strong key={key} className="font-semibold text-fg">{t.slice(2, -2)}</strong>);
    } else if (t.startsWith("`")) {
      out.push(
        <code key={key} className="px-1 py-px rounded bg-n-800/80 border border-line font-mono text-[0.92em] text-yellow">
          {t.slice(1, -1)}
        </code>,
      );
    } else if (t.startsWith("~~")) {
      out.push(<del key={key} className="opacity-60">{t.slice(2, -2)}</del>);
    } else if (t.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
      if (link) {
        // Electron 里 <a href> 会在当前窗口内导航并破坏应用，故点击行为是"复制链接"
        out.push(
          <a
            key={key}
            href={link[2]}
            onClick={(e) => {
              e.preventDefault();
              void navigator.clipboard?.writeText(link[2]).catch(() => {});
            }}
            title={`复制链接：${link[2]}`}
            className="text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary cursor-pointer"
          >
            {link[1]}
          </a>,
        );
      } else {
        out.push(t);
      }
    } else {
      out.push(<em key={key} className="italic opacity-90">{t.slice(1, -1)}</em>);
    }
    last = m.index + t.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// 代码块
// ---------------------------------------------------------------------------

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="my-2 rounded-lg border border-line bg-n-950 overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-7 bg-n-900/80 border-b border-line">
        <span className="text-[10px] font-mono text-fg-faint">{lang || "text"}</span>
        <button
          onClick={copy}
          className="ml-auto flex items-center gap-1 text-[10px] text-fg-faint hover:text-fg-muted transition-colors"
        >
          {copied ? <IconCheck size={11} className="text-green" /> : <IconCopy size={11} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="px-3 py-2.5 overflow-x-auto text-[11.5px] leading-relaxed font-mono text-n-200 whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 块解析
// ---------------------------------------------------------------------------

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;

function parseBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={k()} lang={lang} code={buf.join("\n")} />);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push(<hr key={k()} className="my-3 border-line" />);
      i++;
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "text-[15px]" : level === 2 ? "text-[14px]" : "text-[13px]";
      blocks.push(
        <div key={k()} className={`${cls} font-semibold text-fg mt-3.5 mb-1.5 first:mt-0`}>
          {renderInline(h[2], k())}
        </div>,
      );
      i++;
      continue;
    }

    // 表格（表头 + |---| 分隔行）
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push(
        <div key={k()} className="my-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} className="px-2.5 py-1.5 text-left font-medium text-fg-subtle bg-n-900/70 border-b border-line whitespace-nowrap">
                    {renderInline(c, k())}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-line/60 last:border-b-0">
                  {r.map((c, ci) => (
                    <td key={ci} className="px-2.5 py-1.5 text-fg-muted align-top">{renderInline(c, k())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={k()} className="my-2 pl-3 py-0.5 border-l-2 border-primary-border text-fg-subtle leading-relaxed">
          {renderInline(buf.join(" "), k())}
        </blockquote>,
      );
      continue;
    }

    // 列表
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? OL_RE.test(lines[i]) : UL_RE.test(lines[i]))) {
        items.push(lines[i++].replace(ordered ? OL_RE : UL_RE, ""));
      }
      blocks.push(
        ordered ? (
          <ol key={k()} className="my-1.5 pl-5 space-y-0.5 list-decimal marker:text-fg-faint">
            {items.map((it, ii) => <li key={ii} className="leading-relaxed">{renderInline(it, k())}</li>)}
          </ol>
        ) : (
          <ul key={k()} className="my-1.5 pl-5 space-y-0.5 list-disc marker:text-fg-faint">
            {items.map((it, ii) => <li key={ii} className="leading-relaxed">{renderInline(it, k())}</li>)}
          </ul>
        ),
      );
      continue;
    }

    // 段落：连续普通行合并（markdown 语义：段内换行折叠为空格）
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\|)/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim())
    ) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={k()} className="leading-relaxed my-1 first:mt-0 last:mb-0">
        {renderInline(para.join(" "), k())}
      </p>,
    );
  }

  return blocks;
}

export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="text-[12.5px] text-fg-muted">{blocks}</div>;
}
