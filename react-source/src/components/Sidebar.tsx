import { useState, useEffect } from 'react';
import { ConnectionProfile, SchemaNode } from '../types';
import MacWindowControls from './MacWindowControls';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Search, Database, LogOut, ChevronRight, ChevronDown, Table as TableIcon, LayoutTemplate, MoreHorizontal, Server, HardDrive, Plus } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from './ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from './ui/dropdown-menu';

interface SidebarProps {
  activeConnections: ConnectionProfile[];
  onDisconnect: (id: string) => void;
  connections: ConnectionProfile[];
  onConnect: (id: string) => void;
  onOpenTable: (connectionId: string, tableName: string) => void;
  onOpenStructure: (connectionId: string, tableName: string) => void;
  onNewQuery: (connectionId: string, tableName?: string) => void;
  onNewTable: (connectionId: string, schemaName?: string) => void;
  onOpenErd: (connectionId: string, schemaName: string) => void;
}

// Mock data for schemas
const MOCK_SCHEMAS: SchemaNode[] = [
  {
    name: 'public',
    tables: [
      { name: 'users', type: 'table' },
      { name: 'products', type: 'table' },
      { name: 'orders', type: 'table' },
      { name: 'order_items', type: 'table' },
      { name: 'active_users', type: 'view' },
    ]
  },
  {
    name: 'auth',
    tables: [
      { name: 'sessions', type: 'table' },
      { name: 'tokens', type: 'table' },
    ]
  }
];

export default function Sidebar({ 
  activeConnections, 
  onDisconnect,
  connections,
  onConnect,
  onOpenTable,
  onOpenStructure,
  onNewQuery,
  onNewTable,
  onOpenErd
}: SidebarProps) {
  const [search, setSearch] = useState('');
  const [expandedConnections, setExpandedConnections] = useState<Record<string, boolean>>({});
  const [expandedSchemas, setExpandedSchemas] = useState<Record<string, boolean>>({});

  // Initialize first connection as expanded if not set
  useEffect(() => {
    if (activeConnections.length > 0 && Object.keys(expandedConnections).length === 0) {
      setExpandedConnections({ [activeConnections[0].id]: true });
      setExpandedSchemas({ [`${activeConnections[0].id}-public`]: true });
    }
  }, [activeConnections, expandedConnections]);

  const toggleConnection = (id: string) => {
    setExpandedConnections(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleSchema = (connId: string, schemaName: string) => {
    const key = `${connId}-${schemaName}`;
    setExpandedSchemas(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="w-64 flex flex-col bg-sidebar-bg/50 h-full">
      <MacWindowControls />
      
      <div className="px-4 pb-2 pt-1 border-b border-border/50">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input 
            placeholder="Filter tables..." 
            className="pl-7 h-7 text-xs bg-muted/50 border-none focus-visible:ring-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <ScrollArea className="flex-1 px-2">
        <div className="py-2 space-y-4">
          {activeConnections.map(conn => {
            const isConnExpanded = expandedConnections[conn.id];
            
            return (
              <div key={conn.id}>
                {/* Connection Header */}
                <div 
                  className={`flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer transition-colors group ${isConnExpanded ? 'bg-primary/5 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
                  onClick={() => toggleConnection(conn.id)}
                >
                  <div className="flex items-center gap-2 overflow-hidden">
                    {isConnExpanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                    {conn.driver === 'PostgreSQL' ? <Database className={`w-4 h-4 shrink-0 ${isConnExpanded ? 'text-primary' : ''}`} /> : 
                     conn.driver === 'MongoDB' ? <HardDrive className={`w-4 h-4 shrink-0 ${isConnExpanded ? 'text-primary' : ''}`} /> : 
                     <Server className={`w-4 h-4 shrink-0 ${isConnExpanded ? 'text-primary' : ''}`} />}
                    <span className="truncate font-medium text-sm">{conn.name}</span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className={`h-6 w-6 shrink-0 hover:bg-muted focus:opacity-100 ${isConnExpanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onNewQuery(conn.id)}>
                        <Plus className="w-4 h-4 mr-2" /> New Query
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onDisconnect(conn.id)} className="text-destructive">
                        <LogOut className="w-4 h-4 mr-2" /> Disconnect
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Schemas */}
                {isConnExpanded && (
                  <div className="mt-1 pl-4">
                    {MOCK_SCHEMAS.map(schema => {
                      const schemaKey = `${conn.id}-${schema.name}`;
                      const isSchemaExpanded = expandedSchemas[schemaKey];
                      const filteredTables = schema.tables.filter(t => t.name.toLowerCase().includes(search.toLowerCase()));
                      
                      if (search && filteredTables.length === 0) return null;

                      return (
                        <div key={schema.name} className="mb-1">
                          <ContextMenu>
                            <ContextMenuTrigger>
                              <div 
                                className="flex items-center gap-1 px-2 py-1 hover:bg-muted/50 rounded-md cursor-pointer text-sm font-medium text-muted-foreground"
                                onClick={() => toggleSchema(conn.id, schema.name)}
                              >
                                {isSchemaExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                <Database className="w-3.5 h-3.5 mr-1" />
                                {schema.name}
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-48">
                              <ContextMenuItem onClick={() => onOpenErd(conn.id, schema.name)}>
                                View ER Diagram
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem onClick={() => onNewTable(conn.id, schema.name)}>
                                New Table...
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => onNewQuery(conn.id)}>
                                New Query...
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                          
                          {isSchemaExpanded && (
                            <div className="ml-4 mt-1 space-y-0.5">
                              {filteredTables.map(table => (
                                <ContextMenu key={table.name}>
                                  <ContextMenuTrigger>
                                    <div 
                                      className="flex items-center justify-between px-2 py-1 hover:bg-primary/10 hover:text-primary rounded-md cursor-pointer text-sm transition-colors group"
                                      onClick={() => onOpenTable(conn.id, table.name)}
                                    >
                                      <div className="flex items-center gap-2 overflow-hidden text-muted-foreground group-hover:text-primary">
                                        {table.type === 'view' ? (
                                          <LayoutTemplate className="w-3.5 h-3.5 shrink-0" />
                                        ) : (
                                          <TableIcon className="w-3.5 h-3.5 shrink-0" />
                                        )}
                                        <span className="truncate">{table.name}</span>
                                      </div>
                                      
                                      <DropdownMenu>
                                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                          <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-primary/20 hover:text-primary -mr-1">
                                            <MoreHorizontal className="w-3 h-3" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onOpenTable(conn.id, table.name); }}>
                                            Open Data
                                          </DropdownMenuItem>
                                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onOpenStructure(conn.id, table.name); }}>
                                            Open Structure
                                          </DropdownMenuItem>
                                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onNewQuery(conn.id, table.name); }}>
                                            New Query
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(table.name); }}>
                                            Copy Table Name
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={(e) => e.stopPropagation()}>
                                            Drop Table...
                                          </DropdownMenuItem>
                                        </DropdownMenuContent>
                                      </DropdownMenu>
                                    </div>
                                  </ContextMenuTrigger>
                                  <ContextMenuContent className="w-48">
                                    <ContextMenuItem onClick={() => onOpenTable(conn.id, table.name)}>
                                      Open Data
                                    </ContextMenuItem>
                                    <ContextMenuItem onClick={() => onOpenStructure(conn.id, table.name)}>
                                      Open Structure
                                    </ContextMenuItem>
                                    <ContextMenuItem onClick={() => onNewQuery(conn.id, table.name)}>
                                      New Query
                                    </ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem onClick={() => navigator.clipboard.writeText(table.name)}>
                                      Copy Table Name
                                    </ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem className="text-destructive focus:text-destructive">
                                      Drop Table...
                                    </ContextMenuItem>
                                  </ContextMenuContent>
                                </ContextMenu>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
