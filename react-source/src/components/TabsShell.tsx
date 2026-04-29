import { AppTab, ConnectionProfile } from '../types';
import { Plus, X, Table as TableIcon, LayoutTemplate, Terminal, Waypoints } from 'lucide-react';
import { Button } from './ui/button';
import DataGrid from './DataGrid';
import SchemaView from './SchemaView';
import SqlEditor from './SqlEditor';
import ERDView from './ERDView';

interface TabsShellProps {
  activeConnections: ConnectionProfile[];
  tabs: AppTab[];
  activeTabId: string | null;
  onTabChange: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewQuery: (connectionId: string) => void;
}

export default function TabsShell({
  activeConnections,
  tabs,
  activeTabId,
  onTabChange,
  onCloseTab,
  onNewQuery
}: TabsShellProps) {
  const activeTab = tabs.find(t => t.id === activeTabId);
  const connection = activeTab ? activeConnections.find(c => c.id === activeTab.connectionId) : undefined;
  
  const handleCreateNewQuery = () => {
    if (connection) {
      onNewQuery(connection.id);
    } else if (activeConnections.length > 0) {
      onNewQuery(activeConnections[0].id);
    }
  };
  
  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-background">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <DatabaseIcon className="w-8 h-8 opacity-50" />
        </div>
        <p className="text-lg font-medium mb-2">No open tabs</p>
        <p className="text-sm mb-6">Select a table from the sidebar or open a new query.</p>
        <Button onClick={handleCreateNewQuery}>
          <Plus className="w-4 h-4 mr-2" />
          New Query
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Tab Bar */}
      <div className="h-10 border-b border-border bg-muted/30 flex items-center px-2 gap-1 overflow-x-auto no-scrollbar">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`flex items-center gap-2 px-3 py-1.5 h-8 rounded-md text-sm cursor-pointer select-none min-w-[120px] max-w-[200px] group transition-colors ${
              activeTabId === tab.id 
                ? 'bg-background shadow-sm border border-border/50 text-foreground' 
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.type === 'data' && <TableIcon className="w-3.5 h-3.5 shrink-0" />}
            {tab.type === 'structure' && <LayoutTemplate className="w-3.5 h-3.5 shrink-0" />}
            {tab.type === 'query' && <Terminal className="w-3.5 h-3.5 shrink-0" />}
            {tab.type === 'erd' && <Waypoints className="w-3.5 h-3.5 shrink-0" />}
            
            <span className="truncate flex-1">{tab.title}</span>
            {tab.type !== 'erd' && tab.connectionId && (
              <span className="w-2 h-2 rounded-full shrink-0" title={activeConnections.find(c => c.id === tab.connectionId)?.name} style={{ backgroundColor: activeConnections.find(c => c.id === tab.connectionId)?.color || '#888' }} />
            )}
            
            <div 
              className={`w-4 h-4 rounded-sm flex items-center justify-center hover:bg-muted shrink-0 ${activeTabId === tab.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <X className="w-3 h-3" />
            </div>
          </div>
        ))}
        
        <Button variant="ghost" size="icon" className="h-8 w-8 ml-1 shrink-0 text-muted-foreground hover:text-foreground" onClick={handleCreateNewQuery}>
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden bg-background">
        {activeTab?.type === 'data' && connection && <DataGrid tableName={activeTab.table!} connection={connection} />}
        {activeTab?.type === 'structure' && connection && <SchemaView tableName={activeTab.table!} connection={connection} isNew={activeTab.isNew} />}
        {activeTab?.type === 'query' && connection && <SqlEditor initialQuery={activeTab.query} connection={connection} />}
        {activeTab?.type === 'erd' && <ERDView schemaName={activeTab.schemaName!} />}
      </div>
    </div>
  );
}

function DatabaseIcon(props: any) {
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
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  );
}
