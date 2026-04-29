import { useEffect, useRef } from 'react';
import { AppTab, ConnectionProfile, DataViewMode, QueryLogEntry } from '../../types';
import { ChevronLeft, ChevronRight, Plus, X, Table as TableIcon, LayoutTemplate, Terminal, Waypoints, FunctionSquare, Radio } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../../components/ui/context-menu';
import DataGrid from '../data-grid/data-grid';
import SchemaView from '../schema/schema-view';
import SqlEditor from '../sql-editor/sql-editor';
import DiagramView from '../diagram/diagram-view';
import RoutineView from '../routine/routine-view';
import RealtimeView from '../realtime/realtime-view';
import QueryLog from '../sql-editor/query-log';
import { useRail } from '../../state/rail';

interface TabsShellProps {
  activeConnections: ConnectionProfile[];
  tabs: AppTab[];
  activeTabId: string | null;
  onTabChange: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseTabs: (mode: 'all' | 'others' | 'left' | 'right', anchorId: string) => void;
  onNewQuery: (connectionId: string) => void;
  /** Toolbar "Import" action. Opens the Import-SQL dialog at the workspace
   *  level for the given connection. */
  onImportSql: (connectionId: string) => void;
  /** Data-grid toolbar "Realtime" action — opens a new realtime tab. */
  onOpenRealtime?: (connectionId: string) => void;
  onTabViewModeChange: (tabId: string, mode: DataViewMode) => void;
  /** Persist SQL editor edits back onto the owning query tab. */
  onTabQueryChange?: (tabId: string, query: string) => void;
  /** A new-table structure tab successfully created its table. The
   *  workspace updates the tab so it points at the now-real table
   *  (un-`isNew`, retitled with the saved name). Without this the
   *  schema view stays stuck in "● unsaved changes" forever. */
  onTableCreated?: (tabId: string, savedName: string) => void;
  /** Persist the pattern a realtime tab is currently subscribed to. */
  onTabRealtimePatternChange?: (tabId: string, pattern: string) => void;
  queryLogs: Record<string, QueryLogEntry[]>;
  onAppendQueryLog: (entry: Omit<QueryLogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }) => void;
  onClearQueryLog: (connectionId: string) => void;
  /** True when a server is focused but no database has been picked yet. */
  noDatabaseSelected?: boolean;
  /** Currently-focused database on the rail. Used as fallback when a query
   *  tab wasn't stamped with a schema at creation time. */
  focusedDatabase?: string | null;
}

export default function TabsShell({
  activeConnections,
  tabs,
  activeTabId,
  onTabChange,
  onCloseTab,
  onCloseTabs,
  onNewQuery,
  onImportSql,
  onOpenRealtime,
  onTabViewModeChange,
  onTabQueryChange,
  onTabRealtimePatternChange,
  onTableCreated,
  queryLogs,
  onAppendQueryLog,
  onClearQueryLog,
  noDatabaseSelected,
  focusedDatabase,
}: TabsShellProps) {
  const activeTab = tabs.find(t => t.id === activeTabId);
  const connection = activeTab ? activeConnections.find(c => c.id === activeTab.connectionId) : undefined;
  const rail = useRail();
  // Pick the best-known database for this tab's connection: what the tab
  // captured at creation, or any pinned tile on its server, or the globally
  // focused DB. This keeps the `USE` prefix and autocomplete scoped to a
  // real DB even when tabs outlive the original rail focus.
  const tabDefaultSchema = activeTab?.type === 'query' && activeTab
    ? (activeTab.schema
        ?? rail.tiles.find(t => t.serverId === activeTab.connectionId)?.databaseName
        ?? focusedDatabase
        ?? undefined)
    : undefined;
  
  // Scroll the active tab into view whenever it changes. Matters when a new
  // tab is appended beyond the visible range — without this, the selection
  // moves off-screen and feels broken.
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  // One viewport-width worth of tabs per click feels like too much; step by a
  // comfortable chunk instead. 240px is roughly 1.5 tabs wide.
  const scrollTabs = (dir: 'left' | 'right') => {
    const el = tabScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -240 : 240, behavior: 'smooth' });
  };

  const handleCreateNewQuery = () => {
    if (connection) {
      onNewQuery(connection.id);
    } else if (activeConnections.length > 0) {
      onNewQuery(activeConnections[0].id);
    }
  };
  
  if (tabs.length === 0) {
    if (noDatabaseSelected) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-background px-6 text-center">
          <p className="text-sm">
            No database selected, press{' '}
            <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted text-[11px] font-mono">⌘ + K</kbd>{' '}
            to select a database
          </p>
        </div>
      );
    }
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
    <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
      {/* Tab Bar — the scroll area is width-capped to the workspace content
          area (set on the WorkspaceView root as `--content-max-w`) minus the
          fixed-width left/right arrows and the new-tab button. The arrows and
          `+` sit outside the scroll region so they stay reachable no matter
          how many tabs are open. */}
      <div className="h-10 border-b border-border bg-muted/30 flex items-center px-2 gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => scrollTabs('left')}
          title="Scroll tabs left"
          aria-label="Scroll tabs left"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => scrollTabs('right')}
          title="Scroll tabs right"
          aria-label="Scroll tabs right"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
        <div
          ref={tabScrollRef}
          // `flex-1 min-w-0` is the fix for the classic flex overflow bug:
          // by default a flex child won't shrink below its content width, so
          // the row keeps growing past the viewport. `min-w-0` releases that
          // floor; `flex-1` then makes this element eat the remaining space
          // after the left arrows / new-tab button, and `overflow-x-auto`
          // finally engages inside.
          className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto no-scrollbar"
        >
        {tabs.map((tab, idx) => {
          const hasLeft = idx > 0;
          const hasRight = idx < tabs.length - 1;
          const hasOthers = tabs.length > 1;
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger className="shrink-0">
                <div
                  ref={activeTabId === tab.id ? activeTabRef : null}
                  className={`flex items-center gap-2 px-3 py-1.5 h-8 rounded-md text-sm cursor-pointer select-none min-w-30 max-w-50 shrink-0 group transition-colors ${
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
                  {tab.type === 'routine' && <FunctionSquare className="w-3.5 h-3.5 shrink-0" />}
                  {tab.type === 'realtime' && <Radio className="w-3.5 h-3.5 shrink-0" />}

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
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52">
                <ContextMenuItem onClick={() => onCloseTab(tab.id)}>Close Tab</ContextMenuItem>
                <ContextMenuItem disabled={!hasOthers} onClick={() => onCloseTabs('others', tab.id)}>
                  Close Other Tabs
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasLeft} onClick={() => onCloseTabs('left', tab.id)}>
                  Close Tabs to the Left
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasRight} onClick={() => onCloseTabs('right', tab.id)}>
                  Close Tabs to the Right
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onCloseTabs('all', tab.id)}>
                  Close All Tabs
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleCreateNewQuery}>New Query</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 ml-1 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleCreateNewQuery}
          title="New query"
          aria-label="New query"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-background min-w-0">
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative">
          {/*
            Data tabs are kept mounted across tab switches — only the active
            one is visible. Unmounting would throw away the fetched rows and
            force a refetch every time the user flips between tables, which
            wastes bandwidth and blocks the UI. The query-log panel already
            keys off the active tab, so hidden grids don't compete for it.
          */}
          {tabs.filter(t => t.type === 'data').map(tab => {
            const tabConnection = activeConnections.find(c => c.id === tab.connectionId);
            if (!tabConnection) return null;
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}
              >
                <DataGrid
                  tabId={tab.id}
                  connectionId={tab.connectionId}
                  schema={tab.schema ?? ''}
                  tableName={tab.table!}
                  connection={tabConnection}
                  viewMode={tab.dataViewMode ?? 'table'}
                  onViewModeChange={(mode) => onTabViewModeChange(tab.id, mode)}
                  onImportSql={onImportSql}
                  onOpenRealtime={onOpenRealtime}
                  onLogQuery={(statement, opts) => onAppendQueryLog({
                    connectionId: tabConnection.id,
                    statement,
                    source: opts?.source ?? 'grid',
                    durationMs: opts?.durationMs,
                    status: opts?.status ?? 'ok',
                    message: opts?.message,
                  })}
                />
              </div>
            );
          })}
          {activeTab?.type === 'structure' && connection && (
            <SchemaView
              tableName={activeTab.table!}
              connection={connection}
              schema={activeTab.schema}
              isNew={activeTab.isNew}
              onTableCreated={(savedName) => onTableCreated?.(activeTab.id, savedName)}
            />
          )}
          {activeTab?.type === 'query' && connection && (
            <SqlEditor
              tabId={activeTab.id}
              // Keyed by tab id only — switching tabs still remounts, but
              // same-tab AI writes update the Monaco model in place via an
              // internal effect (no flicker, undo stack preserved).
              key={activeTab.id}
              initialQuery={activeTab.query}
              connection={connection}
              defaultSchema={tabDefaultSchema}
              onQueryChange={(q) => onTabQueryChange?.(activeTab.id, q)}
              onLogQuery={(statement, opts) => onAppendQueryLog({
                connectionId: connection.id,
                statement,
                source: opts?.source ?? 'editor',
                durationMs: opts?.durationMs,
                status: opts?.status ?? 'ok',
                message: opts?.message,
              })}
            />
          )}
          {activeTab?.type === 'erd' && connection && (
            <DiagramView
              scope={activeTab.table ? 'table' : 'schema'}
              connectionId={activeTab.connectionId}
              schemaName={activeTab.schemaName ?? activeTab.schema ?? ''}
              tableName={activeTab.table}
            />
          )}
          {activeTab?.type === 'routine' && connection && activeTab.routine && (
            <RoutineView
              connection={connection}
              schema={activeTab.routine.schema}
              name={activeTab.routine.name}
              kind={activeTab.routine.kind}
              isNew={activeTab.isNew}
              onLogQuery={(statement, opts) => onAppendQueryLog({
                connectionId: connection.id,
                statement,
                source: opts?.source ?? 'system',
                durationMs: opts?.durationMs,
                status: opts?.status ?? 'ok',
                message: opts?.message,
              })}
            />
          )}
          {/*
            Realtime tabs stay mounted across tab switches (same rationale
            as data tabs above): unmounting would cancel the subscription
            and drop the event buffer the user accumulated. Only the active
            one is visible.
          */}
          {tabs.filter(t => t.type === 'realtime').map(tab => {
            const tabConnection = activeConnections.find(c => c.id === tab.connectionId);
            if (!tabConnection) return null;
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}
              >
                <RealtimeView
                  connection={tabConnection}
                  initialPattern={tab.realtimePattern}
                  onPatternChange={(p) => onTabRealtimePatternChange?.(tab.id, p)}
                  onLogQuery={(statement, opts) => onAppendQueryLog({
                    connectionId: tabConnection.id,
                    statement,
                    source: opts?.source ?? 'editor',
                    durationMs: opts?.durationMs,
                    status: opts?.status ?? 'ok',
                    message: opts?.message,
                  })}
                />
              </div>
            );
          })}
        </div>

        {/* Query log — tabs that can fire server-side commands (data, query,
            routine) plus the realtime tab (it runs PUBLISH via runQuery). */}
        {activeTab && connection && (activeTab.type === 'data' || activeTab.type === 'query' || activeTab.type === 'routine' || activeTab.type === 'realtime') && (
          <QueryLog
            entries={queryLogs[connection.id] ?? []}
            onClear={() => onClearQueryLog(connection.id)}
          />
        )}
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
