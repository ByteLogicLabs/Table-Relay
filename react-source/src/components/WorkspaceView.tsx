import { useState } from 'react';
import { ConnectionProfile, AppTab, TabType } from '../types';
import Sidebar from './Sidebar';
import TabsShell from './TabsShell';

interface WorkspaceViewProps {
  activeConnections: ConnectionProfile[];
  onDisconnect: (id: string) => void;
  connections: ConnectionProfile[];
  onConnect: (id: string) => void;
}

export default function WorkspaceView({ 
  activeConnections, 
  onDisconnect,
  connections,
  onConnect
}: WorkspaceViewProps) {
  const [tabs, setTabs] = useState<AppTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const handleOpenTable = (connectionId: string, tableName: string) => {
    const existingTab = tabs.find(t => t.type === 'data' && t.table === tableName && t.connectionId === connectionId);
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      const newTab: AppTab = {
        id: `data-${connectionId}-${tableName}-${Date.now()}`,
        title: tableName,
        type: 'data',
        connectionId,
        table: tableName
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };

  const handleOpenStructure = (connectionId: string, tableName: string) => {
    const existingTab = tabs.find(t => t.type === 'structure' && t.table === tableName && t.connectionId === connectionId);
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      const newTab: AppTab = {
        id: `struct-${connectionId}-${tableName}-${Date.now()}`,
        title: `${tableName} (Structure)`,
        type: 'structure',
        connectionId,
        table: tableName
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };

  const handleNewQuery = (connectionId: string, tableName?: string) => {
    let initialQuery = '';
    const connection = activeConnections.find(c => c.id === connectionId);
    
    if (tableName && connection) {
      if (connection.driver === 'MongoDB') {
        initialQuery = `// Query example for ${tableName}\ndb.getCollection('${tableName}').find({\n  // Add filter conditions here\n}).limit(100);`;
      } else {
        initialQuery = `-- Query example for ${tableName}\nSELECT * FROM ${tableName}\nLIMIT 100;`;
      }
    }

    const newTab: AppTab = {
      id: `query-${connectionId}-${Date.now()}`,
      title: tableName ? `Query: ${tableName}` : 'Query',
      type: 'query',
      connectionId,
      query: initialQuery
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleNewTable = (connectionId: string, schemaName?: string) => {
    const newTab: AppTab = {
      id: `struct-new-${connectionId}-${Date.now()}`,
      title: 'Untitled Table',
      type: 'structure',
      connectionId,
      table: 'untitled_table',
      isNew: true
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleOpenErd = (connectionId: string, schemaName: string) => {
    const newTab: AppTab = {
      id: `erd-${connectionId}-${schemaName}`,
      title: `ERD: ${schemaName}`,
      type: 'erd',
      connectionId,
      schemaName: schemaName
    };
    if (!tabs.find(t => t.id === newTab.id)) {
      setTabs(prev => [...prev, newTab]);
    }
    setActiveTabId(newTab.id);
  };

  const handleCloseTab = (id: string) => {
    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== id);
      if (activeTabId === id) {
        // Find next tab to activate
        const index = prev.findIndex(t => t.id === id);
        if (newTabs.length > 0) {
          const nextIndex = Math.min(index, newTabs.length - 1);
          setActiveTabId(newTabs[nextIndex].id);
        } else {
          setActiveTabId(null);
        }
      }
      return newTabs;
    });
  };

  return (
    <div className="flex-1 flex bg-background relative mac-vibrancy">
      <Sidebar 
        activeConnections={activeConnections} 
        onDisconnect={onDisconnect}
        connections={connections}
        onConnect={onConnect}
        onOpenTable={handleOpenTable}
        onOpenStructure={handleOpenStructure}
        onNewQuery={handleNewQuery}
        onNewTable={handleNewTable}
        onOpenErd={handleOpenErd}
      />
      <div className="flex-1 flex flex-col min-w-0 bg-background border-l border-border/50">
        <TabsShell 
          activeConnections={activeConnections}
          tabs={tabs} 
          activeTabId={activeTabId} 
          onTabChange={setActiveTabId}
          onCloseTab={handleCloseTab}
          onNewQuery={handleNewQuery}
        />
      </div>
    </div>
  );
}
