import { useState } from 'react';
import { Play, AlignLeft, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import DataGrid from './DataGrid';
import { ConnectionProfile } from '../types';

interface SqlEditorProps {
  initialQuery?: string;
  connection: ConnectionProfile;
}

export default function SqlEditor({ initialQuery = '', connection }: SqlEditorProps) {
  const isMongo = connection.driver === 'MongoDB';
  const defaultQuery = isMongo 
    ? '// Enter MongoDB query here\n// Example: db.getCollection("users").find({})\n'
    : '-- Enter SQL query here\n-- Example: SELECT * FROM users\n';
    
  const [query, setQuery] = useState(initialQuery || defaultQuery);
  const [results, setResults] = useState<'none' | 'data' | 'error'>('none');
  const [isExecuting, setIsExecuting] = useState(false);

  const handleRun = () => {
    setIsExecuting(true);
    setTimeout(() => {
      setIsExecuting(false);
      // Mock random error or success
      if (query.toLowerCase().includes('error')) {
        setResults('error');
      } else {
        setResults('data');
      }
    }, 600);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="h-12 border-b border-border flex items-center px-4 bg-muted/10 gap-2">
        <Button size="sm" onClick={handleRun} disabled={isExecuting} className="bg-green-600 hover:bg-green-700 text-white">
          <Play className="w-4 h-4 mr-2" />
          Run All
        </Button>
        <Button variant="outline" size="sm" onClick={handleRun} disabled={isExecuting}>
          Run Current
        </Button>
        <div className="w-px h-4 bg-border mx-1" />
        <Button variant="ghost" size="sm">
          <AlignLeft className="w-4 h-4 mr-2" />
          {isMongo ? 'Format JSON' : 'Format SQL'}
        </Button>
      </div>

      {/* Editor Pane */}
      <div className="flex-1 flex flex-col min-h-[200px] relative">
        {/* Simple textarea for MVP, would use Monaco/CodeMirror in real app */}
        <div className="flex-1 flex bg-muted/5">
          <div className="w-10 bg-muted/30 border-r border-border flex flex-col items-end py-4 px-2 text-xs text-muted-foreground font-mono select-none">
            {query.split('\n').map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 p-4 bg-transparent border-none focus:ring-0 font-mono text-sm resize-none outline-none leading-5"
            spellCheck={false}
          />
        </div>
      </div>

      {/* Results Split Pane */}
      {results !== 'none' && (
        <div className="h-1/2 border-t border-border flex flex-col">
          <div className="h-8 border-b border-border bg-muted/30 flex items-center px-4 text-xs font-medium text-muted-foreground">
            {results === 'data' ? 'Results' : 'Error Console'}
          </div>
          <div className="flex-1 overflow-hidden">
            {results === 'data' ? (
              <DataGrid tableName="query_results" connection={connection} />
            ) : (
              <div className="p-4 text-destructive font-mono text-sm flex items-start gap-2 bg-destructive/5 h-full">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-bold mb-1">{isMongo ? 'MongoDB Query Error' : 'SQL Syntax Error'}</div>
                  <div className="opacity-80">You have an error in your syntax; check the manual that corresponds to your database server version for the right syntax to use near 'error' at line 1.</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
