import { Fragment, useState, type ReactNode } from 'react';

/**
 * A deliberately small markdown subset rendered straight to React elements.
 * Nothing here ever produces raw HTML, so message content cannot inject markup
 * no matter what a user types — that is the whole point of hand-rolling it
 * instead of pulling in a markdown-to-HTML library plus a sanitiser.
 *
 * Supported: ```code blocks```, `inline code`, **bold**, *italic*, __underline__,
 * ~~strike~~, ||spoiler||, > quote, links, @mentions, #channel.
 */

export interface RichTextOptions {
  mentionNames?: Map<string, string>;
  onMentionClick?: (username: string) => void;
  onChannelClick?: (name: string) => void;
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function renderRichText(input: string, options: RichTextOptions = {}): ReactNode {
  const blocks = splitCodeBlocks(input);
  return blocks.map((block, index) => {
    if (block.type === 'code') {
      return <CodeBlock key={`c${index}`} language={block.language} content={block.content} />;
    }
    return <Fragment key={`t${index}`}>{renderLines(block.content, options)}</Fragment>;
  });
}

function CodeBlock({ language, content }: { language?: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const fa = document.documentElement.lang === 'fa';
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language || (fa ? 'متن ساده' : 'plain text')}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(content).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? (fa ? 'کپی شد' : 'Copied') : (fa ? 'کپی کد' : 'Copy code')}
        </button>
      </div>
      <pre><code>{content}</code></pre>
    </div>
  );
}

type Block = { type: 'text' | 'code'; content: string; language?: string };

function splitCodeBlocks(input: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /```([a-zA-Z0-9+#-]{0,16})?\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > cursor) {
      blocks.push({ type: 'text', content: input.slice(cursor, match.index) });
    }
    blocks.push({
      type: 'code',
      language: match[1] || undefined,
      content: match[2].replace(/\n$/, ''),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < input.length) blocks.push({ type: 'text', content: input.slice(cursor) });
  return blocks.length ? blocks : [{ type: 'text', content: input }];
}

function renderLines(text: string, options: RichTextOptions): ReactNode {
  const lines = text.split('\n');
  return lines.map((line, index) => {
    const isQuote = line.startsWith('> ');
    const body = isQuote ? line.slice(2) : line;
    const rendered = renderInline(body, options);
    const key = `l${index}`;

    if (isQuote) {
      return (
        <blockquote className="quote" key={key}>
          {rendered}
        </blockquote>
      );
    }
    return (
      <Fragment key={key}>
        {rendered}
        {index < lines.length - 1 ? <br /> : null}
      </Fragment>
    );
  });
}

interface Rule {
  pattern: RegExp;
  render: (match: RegExpExecArray, options: RichTextOptions, depth: number) => ReactNode;
}

const RULES: Rule[] = [
  {
    pattern: /<@&([a-zA-Z0-9_-]{8,64})>/,
    render: () => <span className="mention">@role</span>,
  },
  {
    pattern: /<:([a-z0-9_]{2,32}):([a-zA-Z0-9_-]{8,64})>/,
    render: (m) => (
      <img
        className="custom-emoji"
        src={`/api/files/${m[2]}`}
        alt={`:${m[1]}:`}
        title={`:${m[1]}:`}
        loading="lazy"
      />
    ),
  },
  {
    pattern: /<sticker:([a-z0-9_]{2,32}):([a-zA-Z0-9_-]{8,64})>/,
    render: (m) => (
      <img
        className="custom-sticker"
        src={`/api/files/${m[2]}`}
        alt={m[1]}
        title={m[1]}
        loading="lazy"
      />
    ),
  },
  {
    pattern: /<sound:([a-z0-9_]{2,32}):([a-zA-Z0-9_-]{8,64})>/,
    render: (m) => (
      <span className="custom-sound">
        <span>🔊 {m[1]}</span>
        <audio src={`/api/files/${m[2]}`} controls preload="none" />
      </span>
    ),
  },
  {
    pattern: /`([^`\n]+)`/,
    render: (m) => <code className="inline-code">{m[1]}</code>,
  },
  {
    pattern: /\|\|([\s\S]+?)\|\|/,
    render: (m, o, d) => (
      <span className="spoiler" onClick={(e) => e.currentTarget.classList.add('revealed')}>
        {renderInline(m[1], o, d + 1)}
      </span>
    ),
  },
  {
    pattern: /\*\*([^\n]+?)\*\*/,
    render: (m, o, d) => <strong>{renderInline(m[1], o, d + 1)}</strong>,
  },
  {
    pattern: /__([^\n]+?)__/,
    render: (m, o, d) => <u>{renderInline(m[1], o, d + 1)}</u>,
  },
  {
    pattern: /~~([^\n]+?)~~/,
    render: (m, o, d) => <s>{renderInline(m[1], o, d + 1)}</s>,
  },
  {
    pattern: /\*([^*\n]+?)\*/,
    render: (m, o, d) => <em>{renderInline(m[1], o, d + 1)}</em>,
  },
  {
    pattern: /https?:\/\/[^\s<>()]+/,
    render: (m) => {
      const href = safeHref(m[0]);
      if (!href) return <span>{m[0]}</span>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="link">
          {m[0].length > 64 ? `${m[0].slice(0, 61)}...` : m[0]}
        </a>
      );
    },
  },
  {
    pattern: /(?:^|(?<=\s))@([a-z0-9._-]{3,32})/,
    render: (m, o) => (
      <button
        type="button"
        className="mention"
        onClick={() => o.onMentionClick?.(m[1])}
        title={`@${m[1]}`}
      >
        @{o.mentionNames?.get(m[1]) ?? m[1]}
      </button>
    ),
  },
  {
    pattern: /(?:^|(?<=\s))#([a-z0-9-]{1,48})/,
    render: (m, o) => (
      <button type="button" className="mention channel" onClick={() => o.onChannelClick?.(m[1])}>
        #{m[1]}
      </button>
    ),
  },
];

function renderInline(text: string, options: RichTextOptions, depth = 0): ReactNode {
  if (depth > 6 || !text) return text;

  let best: { rule: Rule; match: RegExpExecArray } | null = null;
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (!best || match.index < best.match.index) best = { rule, match };
  }

  if (!best) return text;

  const { rule, match } = best;

  return (
    <>
      {text.slice(0, match.index)}
      {rule.render(match, options, depth)}
      {renderInline(text.slice(match.index + match[0].length), options, depth)}
    </>
  );
}

/** Plain-text preview used in sidebars and notifications. */
export function toPlainPreview(input: string, maxLength = 90): string {
  const stripped = input
    .replace(/<:([a-z0-9_]+):[a-zA-Z0-9_-]+>/g, ':$1:')
    .replace(/<sticker:([a-z0-9_]+):[a-zA-Z0-9_-]+>/g, '[sticker: $1]')
    .replace(/<sound:([a-z0-9_]+):[a-zA-Z0-9_-]+>/g, '[sound: $1]')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[*_~`|>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 1)}…` : stripped;
}
