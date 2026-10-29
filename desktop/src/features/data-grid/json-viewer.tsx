import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface JsonViewerProps {
  data: unknown;
  name?: string;
  isLast?: boolean;
  initiallyExpanded?: boolean;
  depth?: number;
  /** For arrays, show `[0]`, `[1]`, ... labels on each item. */
  showArrayIndices?: boolean;
  showLineNumbers?: boolean;
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

export default function JsonViewer({
  data,
  name,
  isLast = true,
  initiallyExpanded = true,
  depth = 0,
  showArrayIndices = false,
  showLineNumbers = true,
}: JsonViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isRoot = depth === 0;
  // Expand two levels by default (root + one nested level) so 2-dimensional
  // arrays are immediately readable while deeper levels stay collapsible.
  const [expanded, setExpanded] = useState(initiallyExpanded && depth < 2);

  const isObject = isContainer(data);
  const isArray = Array.isArray(data);

  const toggle = () => setExpanded(!expanded);
  useLayoutEffect(() => {
    if (!showLineNumbers || !isRoot || !rootRef.current) return;
    const nodes = rootRef.current.querySelectorAll<HTMLElement>('[data-json-line-number]');
    nodes.forEach((node, idx) => {
      node.textContent = String(idx + 1);
    });
  }, [showLineNumbers, isRoot, data, expanded]);

  const renderLine = (lineNo: number | null, content: ReactNode, className = '') => (
    <div className={`grid grid-cols-[44px_minmax(0,1fr)] font-mono text-sm leading-6 break-all ${className}`}>
      <div className="relative">
        {showLineNumbers && (
          <>
            <span
              data-json-line-number
              className="absolute inset-y-0 left-0 w-10 pr-2 text-right text-[11px] text-muted-foreground/70 select-none tabular-nums"
            >
              {lineNo}
            </span>
            <span aria-hidden className="absolute right-0 top-0 bottom-0 w-px bg-border/40" />
          </>
        )}
      </div>
      <div className="min-w-0" style={{ paddingLeft: `${depth * 18}px` }}>{content}</div>
    </div>
  );

  const renderValue = (value: unknown) => {
    if (typeof value === 'string') {
      return <span className="text-green-600 dark:text-green-400">"{value}"</span>;
    }
    if (typeof value === 'number') {
      return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
    }
    if (typeof value === 'boolean') {
      return <span className="text-orange-600 dark:text-orange-400">{value ? 'true' : 'false'}</span>;
    }
    if (value === null) {
      return <span className="text-muted-foreground italic">null</span>;
    }
    return <span>{String(value)}</span>;
  };

  if (!isObject) {
    return renderLine(null, (
      <>
        {name && <span className="text-purple-600 dark:text-purple-400 font-medium">{name.startsWith('[') ? name : `"${name}"`}</span>}
        {name && <span className="mx-1">:</span>}
        {renderValue(data)}
        {!isLast && <span>,</span>}
      </>
    ));
  }

  const entries: [string, unknown][] = isArray
    ? (data as unknown[]).map((value, index) => [String(index), value])
    : Object.entries(data as Record<string, unknown>);

  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';

  if (entries.length === 0) {
    return renderLine(null, (
      <>
        {name && <span className="text-purple-600 dark:text-purple-400 font-medium">{name.startsWith('[') ? name : `"${name}"`}</span>}
        {name && <span className="mx-1">:</span>}
        <span>{openBracket}{closeBracket}</span>
        {!isLast && <span>,</span>}
      </>
    ));
  }

  return (
    <div ref={isRoot ? rootRef : undefined} className="w-full">
      {renderLine(null, (
        <div className="flex items-center cursor-pointer select-none hover:bg-muted/30 w-full pr-2 rounded" onClick={toggle}>
          <span className="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground">
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
          {name && <span className="text-purple-600 dark:text-purple-400 font-medium">{name.startsWith('[') ? name : `"${name}"`}</span>}
          {name && <span className="mx-1">:</span>}
          <span>{openBracket}</span>
          {!expanded && (
            <span className="text-muted-foreground mx-2 italic text-xs">
              {isArray ? `${entries.length} items` : `${entries.length} keys`}
            </span>
          )}
          {!expanded && <span>{closeBracket}</span>}
          {!expanded && !isLast && <span>,</span>}
        </div>
      ))}

      {expanded && (
        <>
          {entries.map(([key, value], index) => (
            <JsonViewer
              key={key}
              name={isArray ? (showArrayIndices ? `[${key}]` : undefined) : key}
              data={value}
              isLast={index === entries.length - 1}
              initiallyExpanded={initiallyExpanded}
              depth={depth + 1}
              showArrayIndices={showArrayIndices}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </>
      )}

      {expanded && renderLine(null, (
        <div className="ml-2">
          {closeBracket}
          {!isLast && <span>,</span>}
        </div>
      ))}
    </div>
  );
}
