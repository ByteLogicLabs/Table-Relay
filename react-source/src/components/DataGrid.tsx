import { useState, useRef, useEffect } from 'react';
import { RefreshCw, Filter, Columns, Check, X, Download, ChevronLeft, ChevronRight, ListTree, Table2 } from 'lucide-react';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from './ui/context-menu';
import { toast } from 'sonner';
import ExportModal from './ExportModal';
import { ConnectionProfile } from '../types';
import JsonViewer from './JsonViewer';

interface DataGridProps {
  tableName: string;
  connection: ConnectionProfile;
}

// Mock data generator
const generateMockData = (tableName: string) => {
  const cols = ['_id', 'name', 'email', 'status', 'created_at', 'metadata'];
  const rows = Array.from({ length: 50 }).map((_, i) => ({
    _id: `60d5ecb8b392d70${i.toString().padStart(3, '0')}`,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.com`,
    status: i % 3 === 0 ? 'inactive' : 'active',
    created_at: new Date(Date.now() - Math.random() * 10000000000).toISOString().split('T')[0],
    metadata: { role: 'user', lastLogin: Date.now() - 10000 }
  }));
  return { cols, rows };
};

export default function DataGrid({ tableName, connection }: DataGridProps) {
  const [data] = useState(() => generateMockData(tableName));
  const [editedCells, setEditedCells] = useState<Record<string, any>>({});
  const [activeEdit, setActiveEdit] = useState<{ rowId: string, col: string, value: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limit, setLimit] = useState('100');
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  const inputRef = useRef<HTMLInputElement>(null);
  
  const isMongo = connection.driver === 'MongoDB';

  // Focus input when editing starts
  useEffect(() => {
    if (activeEdit && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [activeEdit]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setIsRefreshing(false);
      setEditedCells({});
      setActiveEdit(null);
      toast.success('Data refreshed');
    }, 500);
  };

  const handleCellEdit = (rowId: string, col: string, value: string) => {
    const originalValue = data.rows.find(r => r._id === rowId)?.[col as keyof typeof data.rows[0]];
    if (String(originalValue) === value) {
      // Reverted to original, remove from edit mapping
      const newEdits = { ...editedCells };
      delete newEdits[`${rowId}-${col}`];
      setEditedCells(newEdits);
    } else {
      setEditedCells(prev => ({
        ...prev,
        [`${rowId}-${col}`]: value
      }));
    }
  };

  const finishEdit = () => {
    if (activeEdit) {
      handleCellEdit(activeEdit.rowId, activeEdit.col, activeEdit.value);
      setActiveEdit(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      finishEdit();
    } else if (e.key === 'Escape') {
      setActiveEdit(null);
    }
  };

  const handleExport = (config: any) => {
    toast.success(`Exporting as ${config.format.toUpperCase()}...`);
    console.log('Export Config:', config);
    // In a real app, you would download the file here
  };

  const hasEdits = Object.keys(editedCells).length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4 bg-muted/10">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          
          <div className="w-px h-4 bg-border mx-1" />
          
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm">
                <Filter className="w-4 h-4 mr-2" />
                Filter
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-4" align="start">
              <h4 className="font-medium mb-2">Filter Builder</h4>
              <div className="text-sm text-muted-foreground mb-4">No filters applied.</div>
              <Button size="sm" variant="outline" className="w-full">
                <PlusIcon className="w-4 h-4 mr-2" /> Add Condition
              </Button>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm">
                <Columns className="w-4 h-4 mr-2" />
                Columns
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-2" align="start">
              <div className="space-y-1">
                {data.cols.map(col => (
                  <label key={col} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded-md cursor-pointer">
                    <input type="checkbox" defaultChecked className="rounded border-border" />
                    <span className="text-sm">{col}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex items-center gap-2">
          {isMongo && (
            <>
              <div className="flex items-center bg-muted/50 p-0.5 rounded-md border border-border">
                <Button 
                  size="sm" 
                  variant={viewMode === 'table' ? 'secondary' : 'ghost'} 
                  className="h-7 px-2"
                  onClick={() => setViewMode('table')}
                >
                  <Table2 className="w-4 h-4 mr-1.5" /> Table
                </Button>
                <Button 
                  size="sm" 
                  variant={viewMode === 'json' ? 'secondary' : 'ghost'} 
                  className="h-7 px-2"
                  onClick={() => setViewMode('json')}
                >
                  <ListTree className="w-4 h-4 mr-1.5" /> JSON Tree
                </Button>
              </div>
              <div className="w-px h-4 bg-border mx-1" />
            </>
          )}
          {hasEdits && (
            <>
              <Button size="sm" variant="default" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => { setEditedCells({}); toast.success('Changes committed'); }}>
                <Check className="w-4 h-4 mr-2" />
                Commit
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => { setEditedCells({}); setActiveEdit(null); }}>
                <X className="w-4 h-4 mr-2" />
                Discard
              </Button>
              <div className="w-px h-4 bg-border mx-1" />
            </>
          )}
          
          <Button variant="ghost" size="sm" onClick={() => setIsExportModalOpen(true)}>
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      {/* Grid Area */}
      <div className="flex-1 overflow-auto bg-background">
        {viewMode === 'table' ? (
          <table className="w-full text-sm text-left border-collapse">
            <thead className="text-xs text-muted-foreground uppercase bg-muted sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="w-12 px-4 py-2 border-b border-r border-border font-medium text-center whitespace-nowrap">#</th>
                {data.cols.map(col => (
                  <th key={col} className="px-4 py-2 border-b border-r border-border font-medium cursor-pointer hover:bg-muted/50 transition-colors whitespace-nowrap">
                    <div className="flex items-center justify-between gap-2">
                      <span>{col}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, rowIndex) => (
                <tr key={row._id} className="border-b border-border hover:bg-muted/20 transition-colors group">
                  <td className="p-0 border-r border-border text-center text-muted-foreground bg-muted/10 group-hover:bg-muted/30 whitespace-nowrap">
                    <ContextMenu>
                      <ContextMenuTrigger className="block px-4 py-1.5 w-full h-full outline-none">
                        {rowIndex + 1}
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuItem>View Record</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem>Set to NULL</ContextMenuItem>
                        <ContextMenuItem onClick={() => navigator.clipboard.writeText(JSON.stringify(row, null, 2))}>Copy Row as JSON</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem className="text-destructive focus:text-destructive">Delete Row</ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </td>
                  {data.cols.map(col => {
                    const cellKey = `${row._id}-${col}`;
                    const isEdited = editedCells[cellKey] !== undefined;
                    const rawValue = isEdited ? editedCells[cellKey] : (row as any)[col];
                    const value = typeof rawValue === 'object' && rawValue !== null ? JSON.stringify(rawValue) : String(rawValue);
                    const isCurrentlyEditing = activeEdit?.rowId === row._id && activeEdit?.col === col;
                    
                    return (
                      <td 
                        key={col} 
                        className={`p-0 border-r border-border font-mono text-xs ${isEdited ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400' : ''}`}
                        onDoubleClick={() => {
                          setActiveEdit({ rowId: row._id, col, value });
                        }}
                      >
                        {isCurrentlyEditing ? (
                          <input
                            ref={inputRef}
                            type="text"
                            className="w-full h-full px-4 py-1.5 bg-background text-foreground outline-none border-2 border-primary"
                            value={activeEdit.value}
                            onChange={(e) => setActiveEdit({ ...activeEdit, value: e.target.value })}
                            onBlur={finishEdit}
                            onKeyDown={handleKeyDown}
                          />
                        ) : (
                          <ContextMenu>
                            <ContextMenuTrigger className="block px-4 py-1.5 w-full h-full outline-none">
                              <div className="truncate max-w-[250px]" title={value}>
                                {value}
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-48">
                              <ContextMenuItem onClick={() => setActiveEdit({ rowId: row._id, col, value })}>Edit Cell</ContextMenuItem>
                              <ContextMenuItem onClick={() => navigator.clipboard.writeText(value)}>Copy Value</ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem>View Record</ContextMenuItem>
                              <ContextMenuItem onClick={() => handleCellEdit(row._id, col, "NULL")}>Set to NULL</ContextMenuItem>
                              <ContextMenuItem onClick={() => navigator.clipboard.writeText(JSON.stringify(row, null, 2))}>Copy Row as JSON</ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem className="text-destructive focus:text-destructive">Delete Row</ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-4 bg-muted/10 h-full overflow-auto">
            <div className="bg-background border border-border rounded-md p-4 max-w-4xl shadow-sm">
              <JsonViewer data={data.rows} initiallyExpanded={true} />
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="h-10 border-t border-border flex items-center justify-between px-4 bg-muted/10 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>{data.rows.length} rows</span>
          <span>Execution: 12ms</span>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span>Limit:</span>
            <Select value={limit} onValueChange={setLimit}>
              <SelectTrigger className="h-6 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="500">500</SelectItem>
                <SelectItem value="1000">1000</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-6 w-6" disabled>
              <ChevronLeft className="w-3 h-3" />
            </Button>
            <span className="px-2">1 of 1</span>
            <Button variant="outline" size="icon" className="h-6 w-6" disabled>
              <ChevronRight className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>

      <ExportModal 
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        tableName={tableName}
        onExport={handleExport}
      />
    </div>
  );
}

function PlusIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}
