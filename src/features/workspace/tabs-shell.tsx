import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { invoke } from '@tauri-apps/api/core';
import { AppTab, ConnectionProfile, DataViewMode, QueryLogEntry } from '../../types';
import { ChevronLeft, ChevronRight, Plus, X, Table as TableIcon, LayoutTemplate, Terminal, Waypoints, FunctionSquare, Zap, Radio, Loader2, Sparkles } from 'lucide-react';
import { copyText } from '../../lib/clipboard';
import { Button } from '../../components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../../components/ui/context-menu';
import DataGrid from '../data-grid/data-grid';
import SchemaView from '../schema/schema-view';
import SqlEditor from '../sql-editor/sql-editor';
import DiagramView from '../diagram/diagram-view';
import RoutineView from '../routine/routine-view';
import TriggerView from '../trigger/trigger-view';
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
  /** Reorder tabs by drag-and-drop. `activeId` is dropped onto `overId`'s slot. */
  onReorderTabs?: (activeId: string, overId: string) => void;
  onNewQuery: (connectionId: string) => void;
  /** Toolbar "Import" action. Opens the Import-SQL dialog at the workspace
   *  level for the given connection. */
  onImportSql: (connectionId: string) => void;
  /** Data-grid toolbar "Realtime" action — opens a new realtime tab. */
  onOpenRealtime?: (connectionId: string) => void;
  onTabViewModeChange: (tabId: string, mode: DataViewMode) => void;
  /** Persist SQL editor edits back onto the owning query tab. */
  onTabQueryChange?: (tabId: string, query: string) => void;
  /** Persist the file a query tab's buffer is bound to (null = unbind) so
   *  "Save Query" writes back to it across restarts. */
  onTabFilePathChange?: (tabId: string, filePath: string | null) => void;
  /** Persist the trigger editor's in-progress buffer onto its tab so unsaved
   *  edits survive switching away (the editor unmounts on tab switch). */
  onTabTriggerDraftChange?: (tabId: string, draft: string) => void;
  /** An editor reports its unsaved state so the tab shows an unsaved dot. */
  onTabDirtyChange?: (tabId: string, dirty: boolean) => void;
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
  onReorderTabs,
  onNewQuery,
  onImportSql,
  onOpenRealtime,
  onTabViewModeChange,
  onTabQueryChange,
  onTabFilePathChange,
  onTabTriggerDraftChange,
  onTabDirtyChange,
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
  
  // Show the query File-menu items (Load / Save / Save Query As) only while a
  // query tab is active. They're inserted/removed from the native File menu and
  // hiding them frees ⌘S for the data grid's commit shortcut on other tabs.
  const isQueryTabActive = activeTab?.type === 'query';
  useEffect(() => {
    void invoke('set_query_menu_visible', { visible: isQueryTabActive }).catch(() => {
      /* best-effort menu state */
    });
    // Hide on unmount (e.g. back to the home screen, where TabsShell isn't
    // rendered) so the items don't linger when no query tab can be open.
    return () => {
      void invoke('set_query_menu_visible', { visible: false }).catch(() => {});
    };
  }, [isQueryTabActive]);

  // Scroll the active tab into view whenever it changes. Matters when a new
  // tab is appended beyond the visible range — without this, the selection
  // moves off-screen and feels broken.
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const tabScrollRef = useRef<HTMLDivElement | null>(null);

  // Drag-and-drop tab reordering (VSCode-style). Native HTML5 DnD doesn't fire
  // in the Tauri WebView, so we use @dnd-kit (pointer-based). A 5px activation
  // distance keeps a plain click selecting the tab while a real drag reorders.
  const tabDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  // Ordered ids for SortableContext. Sortable shifts the other tabs live as
  // you drag and reorders within this list; the drop is committed via
  // `onReorderTabs`.
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const handleTabDragEnd = useCallback(
    (e: DragEndEvent) => {
      const overId = e.over ? String(e.over.id) : null;
      if (!overId) return;
      const activeId = String(e.active.id);
      if (activeId !== overId) onReorderTabs?.(activeId, overId);
    },
    [onReorderTabs],
  );
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  // One viewport-width worth of tabs per click feels like too much; step by a
  // comfortable chunk instead. 240px is roughly 1.5 tabs wide.
  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    const el = tabScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -240 : 240, behavior: 'smooth' });
  }, []);

  const handleScrollTabsLeft = useCallback(() => scrollTabs('left'), [scrollTabs]);
  const handleScrollTabsRight = useCallback(() => scrollTabs('right'), [scrollTabs]);

  const handleCreateNewQuery = useCallback(() => {
    if (connection) {
      onNewQuery(connection.id);
    } else if (activeConnections.length > 0) {
      onNewQuery(activeConnections[0].id);
    }
  }, [connection, activeConnections, onNewQuery]);

  const openChat = useCallback(() => {
    window.dispatchEvent(new CustomEvent('tablerelay:toggle-chat'));
  }, []);

  const handleClearActiveQueryLog = useCallback(() => {
    if (connection) onClearQueryLog(connection.id);
  }, [connection, onClearQueryLog]);

  const navigateTab = useCallback((direction: 'previous' | 'next') => {
    if (!activeTabId || tabs.length === 0) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    if (idx === -1) return;
    const nextIdx = direction === 'previous'
      ? (idx - 1 + tabs.length) % tabs.length
      : (idx + 1) % tabs.length;
    onTabChange(tabs[nextIdx].id);
  }, [activeTabId, onTabChange, tabs]);

  // Window-level keyboard shortcuts. Scoped here (not inside the tabs map)
  // so they fire regardless of which child surface has focus — closing /
  // navigating tabs is a workspace-level affordance, not bound to any tab's
  // own focus surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Cmd/Ctrl + PageUp / PageDown — previous / next tab. These are safe
      // to fire from anywhere; no app surface uses PageUp/PageDown for
      // editing actions, so we don't need a focus guard.
      if (e.key === 'PageUp') {
        e.preventDefault();
        navigateTab('previous');
        return;
      }
      if (e.key === 'PageDown') {
        e.preventDefault();
        navigateTab('next');
        return;
      }

      // Cmd/Ctrl + W — close active tab. Skip when the user is editing text
      // in Monaco / an input / a textarea / contentEditable surface, so we
      // don't yank the tab out from under someone mid-typing. (Monaco
      // renders into a `.monaco-editor` ancestor; input elements report
      // their tag directly.)
      if (e.key.toLowerCase() === 'w' && !e.shiftKey && activeTabId) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const inEditableSurface =
          tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true
          || target?.closest('.monaco-editor') !== null;
        if (inEditableSurface) return;
        e.preventDefault();
        onCloseTab(activeTabId);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTabId, navigateTab, onCloseTab]);

  // Middle-click closes a tab — standard browser-tab convention. The auxclick
  // event fires for non-primary mouse buttons, with `button === 1` meaning
  // middle. Stop propagation so the parent's onClick (which would activate
  // the tab) doesn't also run.
  const handleTabAuxClick = useCallback((e: React.MouseEvent, tabId: string) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      onCloseTab(tabId);
    }
  }, [onCloseTab]);
  
  if (tabs.length === 0) {
    if (noDatabaseSelected) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-background px-6 text-center gap-4">
          <p className="text-sm">
            No database selected, press{' '}
            <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted text-[11px] font-mono">⌘ + K</kbd>{' '}
            to select a database
          </p>
          <Button variant="outline" size="sm" onClick={openChat}>
            <Sparkles className="w-4 h-4 mr-2 text-primary" />
            Ask AI
          </Button>
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-background">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <DatabaseIcon className="w-8 h-8 opacity-50" />
        </div>
        <p className="text-lg font-medium mb-2">No open tabs</p>
        <p className="text-sm mb-6">Select a table from the sidebar, open a new query, or ask the AI.</p>
        <div className="flex items-center gap-2">
          <Button onClick={handleCreateNewQuery}>
            <Plus className="w-4 h-4 mr-2" />
            New Query
          </Button>
          <Button variant="outline" onClick={openChat}>
            <Sparkles className="w-4 h-4 mr-2 text-primary" />
            Ask AI
          </Button>
        </div>
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
      <div data-tauri-drag-region className="h-10 border-b border-border bg-muted/30 flex items-center px-2 gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleScrollTabsLeft}
          title="Scroll tabs left"
          aria-label="Scroll tabs left"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleScrollTabsRight}
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
        <DndContext
          sensors={tabDndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleTabDragEnd}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab, idx) => {
              const hasLeft = idx > 0;
              const hasRight = idx < tabs.length - 1;
              const hasOthers = tabs.length > 1;
              return (
                <TabBarItem
                  key={tab.id}
                  tab={tab}
                  isActive={activeTabId === tab.id}
                  activeTabRef={activeTabRef}
                  hasLeft={hasLeft}
                  hasRight={hasRight}
                  hasOthers={hasOthers}
                  draggable={!!onReorderTabs}
                  onTabChange={onTabChange}
                  onAuxClick={handleTabAuxClick}
                  onCloseTab={onCloseTab}
                  onCloseTabs={onCloseTabs}
                  onNewQuery={handleCreateNewQuery}
                />
              );
            })}
          </SortableContext>
        </DndContext>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 ml-1 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleCreateNewQuery}
          title="New query"
          aria-label="New query"
        >
          <Terminal className="w-4 h-4" />
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
              <DataPane
                key={tab.id}
                tab={tab}
                tabConnection={tabConnection}
                isActive={isActive}
                onTabViewModeChange={onTabViewModeChange}
                onImportSql={onImportSql}
                onOpenRealtime={onOpenRealtime}
                onTabDirtyChange={onTabDirtyChange}
                onAppendQueryLog={onAppendQueryLog}
              />
            );
          })}
          {/*
            Query / structure / routine / trigger editor tabs stay mounted
            across switches — only the active one is visible. Monaco editors are
            expensive to build (worker setup + tokenizer), so unmounting on every
            switch caused tab-switch lag and dropped cursor/scroll/undo state.
            Keeping them mounted (hidden) makes switching instant. Each renders
            against its own tab's connection so a tab on another connection still
            shows correctly. ERD stays conditional below (heavy graph, not Monaco).
          */}
          {tabs.filter(t => t.type === 'structure').map(tab => {
            const tabConnection = activeConnections.find(c => c.id === tab.connectionId);
            if (!tabConnection) return null;
            const isActive = tab.id === activeTabId;
            return (
              <StructurePane
                key={tab.id}
                tab={tab}
                tabConnection={tabConnection}
                isActive={isActive}
                onTabDirtyChange={onTabDirtyChange}
                onTableCreated={onTableCreated}
              />
            );
          })}
          {tabs.filter(t => t.type === 'query').map(tab => {
            const tabConnection = activeConnections.find(c => c.id === tab.connectionId);
            if (!tabConnection) return null;
            const isActive = tab.id === activeTabId;
            const tabSchema = tab.schema
              ?? rail.tiles.find(t2 => t2.serverId === tab.connectionId)?.databaseName
              ?? tabConnection.database
              ?? undefined;
            return (
              <QueryPane
                key={tab.id}
                tab={tab}
                tabConnection={tabConnection}
                isActive={isActive}
                tabSchema={tabSchema}
                onTabQueryChange={onTabQueryChange}
                onTabFilePathChange={onTabFilePathChange}
                onAppendQueryLog={onAppendQueryLog}
              />
            );
          })}
          {activeTab?.type === 'erd' && connection && (
            <DiagramView
              scope={activeTab.table ? 'table' : 'schema'}
              connectionId={activeTab.connectionId}
              schemaName={activeTab.schemaName ?? activeTab.schema ?? ''}
              tableName={activeTab.table}
            />
          )}
          {tabs.filter(t => t.type === 'routine' && t.routine).map(tab => {
            const tabConnection = activeConnections.find(c => c.id === tab.connectionId);
            if (!tabConnection || !tab.routine) return null;
            const isActive = tab.id === activeTabId;
            return (
              <RoutinePane
                key={tab.id}
                tab={tab}
                tabConnection={tabConnection}
                isActive={isActive}
                onTabDirtyChange={onTabDirtyChange}
                onAppendQueryLog={onAppendQueryLog}
              />
            );
          })}
          {tabs.filter(t => t.type === 'trigger' && t.trigger).map(tab => {
            const tabConnection = activeConnections.find(c => c.id === tab.connectionId);
            if (!tabConnection || !tab.trigger) return null;
            const isActive = tab.id === activeTabId;
            return (
              <TriggerPane
                key={tab.id}
                tab={tab}
                tabConnection={tabConnection}
                isActive={isActive}
                onTabTriggerDraftChange={onTabTriggerDraftChange}
                onTabDirtyChange={onTabDirtyChange}
                onAppendQueryLog={onAppendQueryLog}
              />
            );
          })}
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
              <RealtimePane
                key={tab.id}
                tab={tab}
                tabConnection={tabConnection}
                isActive={isActive}
                onTabRealtimePatternChange={onTabRealtimePatternChange}
                onAppendQueryLog={onAppendQueryLog}
              />
            );
          })}
          {/*
            Connecting placeholder for data / realtime tabs. These render
            from the mounted lists above, which `return null` when the tab's
            connection isn't yet in `activeConnections`. On reload the active
            tab (e.g. a data grid) exists before the async reconnect finishes,
            so its connection is briefly absent and the grid never mounts —
            leaving the main pane blank with no loader. Show a centered
            spinner for that window so the area is never empty. The grid /
            realtime view has its own loading overlay once it mounts.
          */}
          {activeTab
            && (activeTab.type === 'data' || activeTab.type === 'realtime')
            && !connection && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground bg-background">
              <Loader2 className="w-4 h-4 animate-spin" />
              <p className="text-sm">Connecting…</p>
            </div>
          )}

          {/*
            Fallback placeholder. The branches above each render only for a
            specific tab type (data/realtime via the mounted lists, the rest
            via `activeTab?.type === …`). If a tab is active but none of them
            match — an unknown/future tab type, or a known type whose
            `connection` hasn't resolved yet — the content area would render
            nothing and the pane goes black. This keeps something visible.
          */}
          {activeTab
            && activeTab.type !== 'data'
            && activeTab.type !== 'realtime'
            && !(
              (activeTab.type === 'structure' && connection)
              || (activeTab.type === 'query' && connection)
              || (activeTab.type === 'erd' && connection)
              || (activeTab.type === 'routine' && connection && activeTab.routine)
              || (activeTab.type === 'trigger' && connection && activeTab.trigger)
            ) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground bg-background px-6 text-center">
              <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
                <DatabaseIcon className="w-7 h-7 opacity-40" />
              </div>
              <p className="text-sm font-medium text-foreground/80">Nothing to show here</p>
              <p className="text-xs max-w-xs">
                Pick a table or collection from the sidebar, or open a new query to get started.
              </p>
            </div>
          )}
        </div>

        {/* Query log — tabs that can fire server-side commands (data, query,
            routine) plus the realtime tab (it runs PUBLISH via runQuery). */}
        {activeTab && connection && (activeTab.type === 'data' || activeTab.type === 'query' || activeTab.type === 'routine' || activeTab.type === 'trigger' || activeTab.type === 'realtime') && (
          <QueryLog
            entries={queryLogs[connection.id] ?? []}
            onClear={handleClearActiveQueryLog}
          />
        )}
      </div>
    </div>
  );
}

type AppendQueryLogFn = (
  entry: Omit<QueryLogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number },
) => void;

interface DataPaneProps {
  tab: AppTab;
  tabConnection: ConnectionProfile;
  isActive: boolean;
  onTabViewModeChange: (tabId: string, mode: DataViewMode) => void;
  onImportSql: (connectionId: string) => void;
  onOpenRealtime?: (connectionId: string) => void;
  onTabDirtyChange?: (tabId: string, dirty: boolean) => void;
  onAppendQueryLog: AppendQueryLogFn;
}

function DataPane({
  tab,
  tabConnection,
  isActive,
  onTabViewModeChange,
  onImportSql,
  onOpenRealtime,
  onTabDirtyChange,
  onAppendQueryLog,
}: DataPaneProps) {
  const handleViewModeChange = useCallback(
    (mode: DataViewMode) => onTabViewModeChange(tab.id, mode),
    [onTabViewModeChange, tab.id],
  );
  const handleDirtyChange = useCallback(
    (d: boolean) => onTabDirtyChange?.(tab.id, d),
    [onTabDirtyChange, tab.id],
  );
  const handleLogQuery = useCallback(
    (statement: string, opts?: { source?: QueryLogEntry['source']; durationMs?: number; status?: QueryLogEntry['status']; message?: string }) =>
      onAppendQueryLog({
        connectionId: tabConnection.id,
        statement,
        source: opts?.source ?? 'grid',
        durationMs: opts?.durationMs,
        status: opts?.status ?? 'ok',
        message: opts?.message,
      }),
    [onAppendQueryLog, tabConnection.id],
  );
  return (
    <div className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}>
      <DataGrid
        tabId={tab.id}
        isActive={isActive}
        connectionId={tab.connectionId}
        schema={tab.schema ?? ''}
        tableName={tab.table!}
        connection={tabConnection}
        viewMode={tab.dataViewMode ?? 'table'}
        onViewModeChange={handleViewModeChange}
        onImportSql={onImportSql}
        onOpenRealtime={onOpenRealtime}
        onDirtyChange={handleDirtyChange}
        onLogQuery={handleLogQuery}
      />
    </div>
  );
}

interface StructurePaneProps {
  tab: AppTab;
  tabConnection: ConnectionProfile;
  isActive: boolean;
  onTabDirtyChange?: (tabId: string, dirty: boolean) => void;
  onTableCreated?: (tabId: string, savedName: string) => void;
}

function StructurePane({
  tab,
  tabConnection,
  isActive,
  onTabDirtyChange,
  onTableCreated,
}: StructurePaneProps) {
  const handleDirtyChange = useCallback(
    (d: boolean) => onTabDirtyChange?.(tab.id, d),
    [onTabDirtyChange, tab.id],
  );
  const handleTableCreated = useCallback(
    (savedName: string) => onTableCreated?.(tab.id, savedName),
    [onTableCreated, tab.id],
  );
  return (
    <div className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}>
      <SchemaView
        tableName={tab.table!}
        connection={tabConnection}
        schema={tab.schema}
        isNew={tab.isNew}
        onDirtyChange={handleDirtyChange}
        onTableCreated={handleTableCreated}
      />
    </div>
  );
}

interface QueryPaneProps {
  tab: AppTab;
  tabConnection: ConnectionProfile;
  isActive: boolean;
  tabSchema: string | undefined;
  onTabQueryChange?: (tabId: string, query: string) => void;
  onTabFilePathChange?: (tabId: string, filePath: string | null) => void;
  onAppendQueryLog: AppendQueryLogFn;
}

function QueryPane({
  tab,
  tabConnection,
  isActive,
  tabSchema,
  onTabQueryChange,
  onTabFilePathChange,
  onAppendQueryLog,
}: QueryPaneProps) {
  const handleQueryChange = useCallback(
    (q: string) => onTabQueryChange?.(tab.id, q),
    [onTabQueryChange, tab.id],
  );
  const handleFilePathChange = useCallback(
    (path: string | null) => onTabFilePathChange?.(tab.id, path),
    [onTabFilePathChange, tab.id],
  );
  const handleLogQuery = useCallback(
    (statement: string, opts?: { source?: QueryLogEntry['source']; durationMs?: number; status?: QueryLogEntry['status']; message?: string }) =>
      onAppendQueryLog({
        connectionId: tabConnection.id,
        statement,
        source: opts?.source ?? 'editor',
        durationMs: opts?.durationMs,
        status: opts?.status ?? 'ok',
        message: opts?.message,
      }),
    [onAppendQueryLog, tabConnection.id],
  );
  return (
    <div className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}>
      <SqlEditor
        tabId={tab.id}
        isActive={isActive}
        initialQuery={tab.query}
        initialFilePath={tab.filePath}
        connection={tabConnection}
        defaultSchema={tabSchema}
        onQueryChange={handleQueryChange}
        onFilePathChange={handleFilePathChange}
        onLogQuery={handleLogQuery}
      />
    </div>
  );
}

interface RoutinePaneProps {
  tab: AppTab;
  tabConnection: ConnectionProfile;
  isActive: boolean;
  onTabDirtyChange?: (tabId: string, dirty: boolean) => void;
  onAppendQueryLog: AppendQueryLogFn;
}

function RoutinePane({
  tab,
  tabConnection,
  isActive,
  onTabDirtyChange,
  onAppendQueryLog,
}: RoutinePaneProps) {
  const handleDirtyChange = useCallback(
    (d: boolean) => onTabDirtyChange?.(tab.id, d),
    [onTabDirtyChange, tab.id],
  );
  const handleLogQuery = useCallback(
    (statement: string, opts?: { source?: QueryLogEntry['source']; durationMs?: number; status?: QueryLogEntry['status']; message?: string }) =>
      onAppendQueryLog({
        connectionId: tabConnection.id,
        statement,
        source: opts?.source ?? 'system',
        durationMs: opts?.durationMs,
        status: opts?.status ?? 'ok',
        message: opts?.message,
      }),
    [onAppendQueryLog, tabConnection.id],
  );
  return (
    <div className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}>
      <RoutineView
        connection={tabConnection}
        schema={tab.routine!.schema}
        name={tab.routine!.name}
        kind={tab.routine!.kind}
        isNew={tab.isNew}
        onDirtyChange={handleDirtyChange}
        onLogQuery={handleLogQuery}
      />
    </div>
  );
}

interface TriggerPaneProps {
  tab: AppTab;
  tabConnection: ConnectionProfile;
  isActive: boolean;
  onTabTriggerDraftChange?: (tabId: string, draft: string) => void;
  onTabDirtyChange?: (tabId: string, dirty: boolean) => void;
  onAppendQueryLog: AppendQueryLogFn;
}

function TriggerPane({
  tab,
  tabConnection,
  isActive,
  onTabTriggerDraftChange,
  onTabDirtyChange,
  onAppendQueryLog,
}: TriggerPaneProps) {
  const handleDraftChange = useCallback(
    (d: string) => onTabTriggerDraftChange?.(tab.id, d),
    [onTabTriggerDraftChange, tab.id],
  );
  const handleDirtyChange = useCallback(
    (d: boolean) => onTabDirtyChange?.(tab.id, d),
    [onTabDirtyChange, tab.id],
  );
  const handleLogQuery = useCallback(
    (statement: string, opts?: { source?: QueryLogEntry['source']; durationMs?: number; status?: QueryLogEntry['status']; message?: string }) =>
      onAppendQueryLog({
        connectionId: tabConnection.id,
        statement,
        source: opts?.source ?? 'system',
        durationMs: opts?.durationMs,
        status: opts?.status ?? 'ok',
        message: opts?.message,
      }),
    [onAppendQueryLog, tabConnection.id],
  );
  return (
    <div className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}>
      <TriggerView
        connection={tabConnection}
        schema={tab.trigger!.schema}
        name={tab.trigger!.name}
        isNew={tab.trigger!.isNew}
        initialSql={tab.trigger!.initialSql}
        draft={tab.trigger!.draft}
        onDraftChange={handleDraftChange}
        onDirtyChange={handleDirtyChange}
        onLogQuery={handleLogQuery}
      />
    </div>
  );
}

interface RealtimePaneProps {
  tab: AppTab;
  tabConnection: ConnectionProfile;
  isActive: boolean;
  onTabRealtimePatternChange?: (tabId: string, pattern: string) => void;
  onAppendQueryLog: AppendQueryLogFn;
}

function RealtimePane({
  tab,
  tabConnection,
  isActive,
  onTabRealtimePatternChange,
  onAppendQueryLog,
}: RealtimePaneProps) {
  const handlePatternChange = useCallback(
    (p: string) => onTabRealtimePatternChange?.(tab.id, p),
    [onTabRealtimePatternChange, tab.id],
  );
  const handleLogQuery = useCallback(
    (statement: string, opts?: { source?: QueryLogEntry['source']; durationMs?: number; status?: QueryLogEntry['status']; message?: string }) =>
      onAppendQueryLog({
        connectionId: tabConnection.id,
        statement,
        source: opts?.source ?? 'editor',
        durationMs: opts?.durationMs,
        status: opts?.status ?? 'ok',
        message: opts?.message,
      }),
    [onAppendQueryLog, tabConnection.id],
  );
  return (
    <div className={`absolute inset-0 flex flex-col ${isActive ? '' : 'hidden'}`}>
      <RealtimeView
        connection={tabConnection}
        initialPattern={tab.realtimePattern}
        onPatternChange={handlePatternChange}
        onLogQuery={handleLogQuery}
      />
    </div>
  );
}

interface TabBarItemProps {
  tab: AppTab;
  isActive: boolean;
  activeTabRef: React.RefObject<HTMLDivElement | null>;
  hasLeft: boolean;
  hasRight: boolean;
  hasOthers: boolean;
  /** Enable drag-and-drop reordering for this tab. */
  draggable: boolean;
  onTabChange: (id: string) => void;
  onAuxClick: (e: React.MouseEvent, tabId: string) => void;
  onCloseTab: (id: string) => void;
  onCloseTabs: (mode: 'all' | 'others' | 'left' | 'right', anchorId: string) => void;
  onNewQuery: () => void;
}

function TabBarItem({
  tab,
  isActive,
  activeTabRef,
  hasLeft,
  hasRight,
  hasOthers,
  draggable,
  onTabChange,
  onAuxClick,
  onCloseTab,
  onCloseTabs,
  onNewQuery,
}: TabBarItemProps) {
  // Sortable makes the tab a drag source + drop target and shifts the sibling
  // tabs live as it is dragged (VSCode-style). `transition` animates that
  // shift; `transform` moves this tab.
  const {
    setNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id, disabled: !draggable });
  // The tab div needs sortable's node ref plus (when active) the parent's
  // `activeTabRef` for scroll-into-view. Merge them in a stable callback and
  // mirror the node into `activeTabRef` from an effect so switching the active
  // tab can't leave it dangling.
  const localNodeRef = useRef<HTMLDivElement | null>(null);
  const setTabNodeRef = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      localNodeRef.current = el;
    },
    [setNodeRef],
  );
  useEffect(() => {
    if (isActive) activeTabRef.current = localNodeRef.current;
  }, [isActive, activeTabRef]);
  const handleSelect = useCallback(() => onTabChange(tab.id), [onTabChange, tab.id]);
  const handleAuxClick = useCallback((e: React.MouseEvent) => onAuxClick(e, tab.id), [onAuxClick, tab.id]);
  // Suppress the browser's "open in new tab" middle-click
  // behavior on links inside the tab content area too — but
  // mainly here to silence the default scroll-to-pan cursor.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  }, []);
  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCloseTab(tab.id);
  }, [onCloseTab, tab.id]);
  const handleCloseTab = useCallback(() => onCloseTab(tab.id), [onCloseTab, tab.id]);
  const handleCloseOthers = useCallback(() => onCloseTabs('others', tab.id), [onCloseTabs, tab.id]);
  const handleCloseLeft = useCallback(() => onCloseTabs('left', tab.id), [onCloseTabs, tab.id]);
  const handleCloseRight = useCallback(() => onCloseTabs('right', tab.id), [onCloseTabs, tab.id]);
  const handleCloseAll = useCallback(() => onCloseTabs('all', tab.id), [onCloseTabs, tab.id]);
  const handleCopyTitle = useCallback(() => {
    void copyText(tab.title, 'Title copied');
  }, [tab.title]);

  return (
    <ContextMenu>
      <ContextMenuTrigger className="shrink-0">
        <div
          ref={setTabNodeRef}
          {...listeners}
          {...attributes}
          style={{
            // Sortable drives both the drag movement and the live shift of the
            // other tabs. Lock Y so tabs never drift vertically out of the strip.
            transform: transform ? CSS.Transform.toString({ ...transform, y: 0 }) : undefined,
            transition: transition ?? undefined,
          }}
          className={`flex items-center gap-2 px-3 py-1.5 h-8 rounded-md text-sm cursor-pointer select-none min-w-30 max-w-50 shrink-0 group transition-colors ${
            isActive
              ? 'bg-background shadow-sm border border-border/50 text-foreground'
              : 'text-muted-foreground hover:bg-muted/50'
          } ${isDragging ? 'opacity-50 z-10' : ''}`}
          onClick={handleSelect}
          onAuxClick={handleAuxClick}
          // Suppress the browser's "open in new tab" middle-click
          // behavior on links inside the tab content area too — but
          // mainly here to silence the default scroll-to-pan cursor.
          onMouseDown={handleMouseDown}
        >
          {tab.type === 'data' && <TableIcon className="w-3.5 h-3.5 shrink-0" />}
          {tab.type === 'structure' && <LayoutTemplate className="w-3.5 h-3.5 shrink-0" />}
          {tab.type === 'query' && <Terminal className="w-3.5 h-3.5 shrink-0" />}
          {tab.type === 'erd' && <Waypoints className="w-3.5 h-3.5 shrink-0" />}
          {tab.type === 'routine' && <FunctionSquare className="w-3.5 h-3.5 shrink-0" />}
          {tab.type === 'trigger' && <Zap className="w-3.5 h-3.5 shrink-0" />}
          {tab.type === 'realtime' && <Radio className="w-3.5 h-3.5 shrink-0" />}

          <span className="truncate flex-1">{tab.title}</span>

          {/* Close / unsaved-dot slot (VSCode-style). When the tab has
              unsaved edits we show a dot by default and reveal the X on
              hover; otherwise the X follows the usual show-on-active/
              hover rule. The dot sits in the SAME slot so the layout
              never shifts. */}
          <div
            className={`group/close relative w-4 h-4 rounded-sm flex items-center justify-center hover:bg-muted shrink-0 ${
              tab.dirty || isActive
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100'
            }`}
            title={tab.dirty ? 'Unsaved changes — click to close' : 'Close'}
            onClick={handleCloseClick}
          >
            {tab.dirty && (
              <span className="absolute inset-0 flex items-center justify-center group-hover/close:opacity-0 transition-opacity">
                <span className="w-2 h-2 rounded-full bg-sky-500 dark:bg-sky-400" />
              </span>
            )}
            <X
              className={`w-3 h-3 ${tab.dirty ? 'opacity-0 group-hover/close:opacity-100 transition-opacity' : ''}`}
            />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={handleCloseTab}>Close Tab</ContextMenuItem>
        <ContextMenuItem disabled={!hasOthers} onClick={handleCloseOthers}>
          Close Other Tabs
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasLeft} onClick={handleCloseLeft}>
          Close Tabs to the Left
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasRight} onClick={handleCloseRight}>
          Close Tabs to the Right
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCloseAll}>
          Close All Tabs
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleCopyTitle}>
          Copy Title
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onNewQuery}>New Query</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
