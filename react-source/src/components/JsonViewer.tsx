import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface JsonViewerProps {
  data: any;
  name?: string;
  isLast?: boolean;
  initiallyExpanded?: boolean;
}

export default function JsonViewer({ data, name, isLast = true, initiallyExpanded = true }: JsonViewerProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);

  const isObject = typeof data === 'object' && data !== null;
  const isArray = Array.isArray(data);

  const toggle = () => setExpanded(!expanded);

  const renderValue = (value: any) => {
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
    return (
      <div className="font-mono text-sm leading-6">
        {name && <span className="text-purple-600 dark:text-purple-400 font-medium">"{name}"</span>}
        {name && <span className="mx-1">:</span>}
        {renderValue(data)}
        {!isLast && <span>,</span>}
      </div>
    );
  }

  const keys = Object.keys(data);
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';

  if (keys.length === 0) {
    return (
      <div className="font-mono text-sm leading-6">
        {name && <span className="text-purple-600 dark:text-purple-400 font-medium">"{name}"</span>}
        {name && <span className="mx-1">:</span>}
        <span>{openBracket}{closeBracket}</span>
        {!isLast && <span>,</span>}
      </div>
    );
  }

  return (
    <div className="font-mono text-sm leading-6">
      <div className="flex items-center cursor-pointer select-none hover:bg-muted/30 w-fit pr-2 rounded" onClick={toggle}>
        <span className="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground">
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
        {name && <span className="text-purple-600 dark:text-purple-400 font-medium">"{name}"</span>}
        {name && <span className="mx-1">:</span>}
        <span>{openBracket}</span>
        {!expanded && (
          <span className="text-muted-foreground mx-2 italic text-xs">
            {isArray ? `${keys.length} items` : `${keys.length} keys`}
          </span>
        )}
        {!expanded && <span>{closeBracket}</span>}
        {!expanded && !isLast && <span>,</span>}
      </div>

      {expanded && (
        <div className="pl-6 border-l border-border/50 ml-2">
          {keys.map((key, index) => (
            <JsonViewer
              key={key}
              name={isArray ? undefined : key}
              data={(data as any)[key]}
              isLast={index === keys.length - 1}
              initiallyExpanded={initiallyExpanded}
            />
          ))}
        </div>
      )}
      
      {expanded && (
        <div className="ml-2">
          {closeBracket}
          {!isLast && <span>,</span>}
        </div>
      )}
    </div>
  );
}
