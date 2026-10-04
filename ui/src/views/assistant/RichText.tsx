import { useMemo } from 'react';
import { parseBlocks, type Inline } from './markdown';

/** Renders model text as React text nodes only (no HTML), with light formatting. */
export function RichText({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const caret = streaming ? <span className="as-caret" aria-hidden /> : null;
  if (!blocks.length) return <div className="as-rich">{caret}</div>;
  return (
    <div className="as-rich">
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1;
        switch (b.type) {
          case 'h':
            return (
              <p key={i} className="as-rich__h">
                <Runs parts={b.inline} />
                {last && caret}
              </p>
            );
          case 'p':
            return (
              <p key={i}>
                {b.lines.map((line, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    <Runs parts={line} />
                  </span>
                ))}
                {last && caret}
              </p>
            );
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Runs parts={item} />
                    {last && j === b.items.length - 1 && caret}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={b.start}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Runs parts={item} />
                    {last && j === b.items.length - 1 && caret}
                  </li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}

function Runs({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}
    </>
  );
}
