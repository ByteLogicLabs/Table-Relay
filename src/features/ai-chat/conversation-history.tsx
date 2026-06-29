import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { copyText } from '../../lib/clipboard';
import { History, Loader2, MessageSquare, Trash2, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { DestructiveConfirmDialog } from '../../components/destructive-confirm-dialog';
import { useMultiSelection } from '../../hooks/use-multi-selection';
import { getClickIntent, getKeyIntent } from '../../lib/click-intent';
import { type Conversation, errorMessage } from '../../lib/ai';
import { listConversations, loadConversation, deleteConversation, deleteAllConversations } from '../../state/ai';

interface Props {
  onSelect?: () => void;
}

export function ConversationHistory({ onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  // Id of the conversation currently being resumed. Drives a per-row spinner
  // and blocks duplicate opens — restoring a long transcript (re-seeding the
  // backend session + messages) can take a beat and otherwise looks frozen.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmTargets, setConfirmTargets] = useState<Conversation[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const orderedIds = useCallback(() => conversations.map(c => c.id), [conversations]);
  const selection = useMultiSelection(orderedIds);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listConversations(30);
      setConversations(list);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) selection.clearSelection();
    // `selection` is a fresh object every render; depend only on the stable
    // callback ref + the boolean we actually care about. Without this we
    // re-trigger the effect on every render → infinite update loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selection.clearSelection]);

  const openConversation = useCallback(async (id: string) => {
    // Guard against double-open (Enter + click, or impatient re-clicks while the
    // first resume is still in flight).
    if (openingId) return;
    setOpeningId(id);
    try {
      await loadConversation(id);
      setOpen(false);
      onSelect?.();
    } catch (e) {
      // e.g. no credentials to start a session with. Keep the overlay open and
      // surface why instead of silently doing nothing.
      toast.error(errorMessage(e));
    } finally {
      setOpeningId(null);
    }
  }, [onSelect, openingId]);

  const requestDelete = useCallback((ids: string[]) => {
    const targets = conversations.filter(c => ids.includes(c.id));
    if (targets.length === 0) return;
    setConfirmTargets(targets);
  }, [conversations]);

  const performDelete = useCallback(async () => {
    if (!confirmTargets) return;
    // Deleting every conversation → one bulk call instead of N round-trips.
    if (confirmTargets.length === conversations.length && conversations.length > 0) {
      try { await deleteAllConversations(); } catch { /* ignore */ }
    } else {
      for (const conv of confirmTargets) {
        try { await deleteConversation(conv.id); } catch { /* ignore */ }
      }
    }
    selection.clearSelection();
    void refresh();
  }, [confirmTargets, conversations.length, refresh, selection]);

  const handleRowClick = useCallback((e: React.MouseEvent, id: string) => {
    const intent = getClickIntent(e);
    switch (intent.kind) {
      case 'open':
        selection.selectOnly(id);
        void openConversation(id);
        break;
      case 'toggle':
        selection.toggleSelection(id);
        break;
      case 'range':
        selection.selectRange(id);
        break;
      case 'context':
        // ContextMenuTrigger handles right-click; ensure clicked row is in selection.
        if (!selection.selectedIds.has(id)) selection.selectOnly(id);
        break;
    }
  }, [openConversation, selection]);

  const handleRowContextMenu = useCallback((id: string) => {
    if (!selection.selectedIds.has(id)) selection.selectOnly(id);
  }, [selection]);

  const moveFocus = useCallback((direction: 'up' | 'down') => {
    const ids = orderedIds();
    if (ids.length === 0) return;
    const current = selection.focusedId ?? selection.anchorId ?? ids[0];
    const idx = ids.indexOf(current);
    const nextIdx = direction === 'up'
      ? Math.max(0, idx - 1)
      : Math.min(ids.length - 1, idx + 1);
    const nextId = ids[nextIdx];
    selection.selectOnly(nextId);
  }, [orderedIds, selection]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const intent = getKeyIntent(e);
    if (!intent) return;

    switch (intent.kind) {
      case 'escape':
        if (selection.selectedIds.size > 0) {
          e.preventDefault();
          selection.clearSelection();
        } else {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case 'open':
        if (selection.focusedId) {
          e.preventDefault();
          void openConversation(selection.focusedId);
        }
        break;
      case 'move':
        if (intent.direction === 'up' || intent.direction === 'down') {
          e.preventDefault();
          moveFocus(intent.direction);
        }
        break;
      case 'extend':
        if (selection.focusedId) {
          e.preventDefault();
          const ids = orderedIds();
          const idx = ids.indexOf(selection.focusedId);
          const nextIdx = intent.direction === 'up'
            ? Math.max(0, idx - 1)
            : Math.min(ids.length - 1, idx + 1);
          selection.selectRange(ids[nextIdx]);
        }
        break;
      case 'select-all':
        e.preventDefault();
        selection.selectAll(orderedIds());
        break;
      case 'remove-view':
        // Conversations are app-local state; plain Delete removes them per spec.
        if (selection.selectedIds.size > 0) {
          e.preventDefault();
          requestDelete([...selection.selectedIds]);
        }
        break;
      case 'remove-destructive':
        if (selection.selectedIds.size > 0) {
          e.preventDefault();
          requestDelete([...selection.selectedIds]);
        }
        break;
      case 'refresh':
        e.preventDefault();
        void refresh();
        break;
    }
  }, [moveFocus, openConversation, orderedIds, refresh, requestDelete, selection]);

  const overlayClasses = useMemo(
    () => 'absolute inset-0 z-[100] bg-background text-foreground flex flex-col',
    [],
  );

  const handleOpenHistory = useCallback(() => setOpen(true), []);
  const handleCloseHistory = useCallback(() => setOpen(false), []);
  const handleDeleteSelected = useCallback(
    () => requestDelete([...selection.selectedIds]),
    [requestDelete, selection],
  );
  const handleClearAll = useCallback(
    () => requestDelete(conversations.map(c => c.id)),
    [conversations, requestDelete],
  );
  const handleConfirmOpenChange = useCallback((o: boolean) => {
    if (!o) setConfirmTargets(null);
  }, []);
  const handleConfirmDelete = useCallback(() => {
    void performDelete();
  }, [performDelete]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        title="Chat history"
        aria-label="Chat history"
        onClick={handleOpenHistory}
      >
        <History className="w-3.5 h-3.5" />
      </Button>

      {open && (
        <div
          className={overlayClasses}
          ref={listRef}
          onKeyDown={handleKeyDown}
          tabIndex={-1}
        >
          <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-muted/10">
            <div className="flex items-center gap-2 min-w-0">
              <History className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">Chat History</div>
                <div className="text-[10px] text-muted-foreground">
                  {selection.selectedIds.size > 0
                    ? `${selection.selectedIds.size} selected`
                    : 'Saved conversations'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {openingId && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground mr-1">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Resuming…
                </span>
              )}
              {loading && !openingId && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
              {selection.selectedIds.size > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-destructive hover:text-destructive"
                  onClick={handleDeleteSelected}
                  title="Delete selected"
                >
                  Delete {selection.selectedIds.size}
                </Button>
              )}
              {conversations.length > 0 && selection.selectedIds.size === 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-destructive hover:text-destructive"
                  onClick={handleClearAll}
                  title="Delete all conversations"
                >
                  Clear all
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleCloseHistory}
                title="Close history"
                aria-label="Close history"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            {conversations.length === 0 && !loading && (
              <div className="h-full flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
                No saved conversations
              </div>
            )}
            <div className="max-w-4xl mx-auto w-full divide-y divide-border" role="listbox" aria-label="Saved conversations">
              {conversations.map(conv => {
                const isSelected = selection.selectedIds.has(conv.id);
                const isFocused = selection.focusedId === conv.id;
                const isOpening = openingId === conv.id;
                // While a resume is in flight, dim the other rows so it's clear
                // the click registered and the panel is busy.
                const dimmed = openingId !== null && !isOpening;
                const multiSelected =
                  selection.selectedIds.size > 1 && selection.selectedIds.has(conv.id);
                return (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    isSelected={isSelected}
                    isFocused={isFocused}
                    isOpening={isOpening}
                    dimmed={dimmed}
                    anyOpening={openingId !== null}
                    multiSelected={multiSelected}
                    selectedCount={selection.selectedIds.size}
                    onRowClick={handleRowClick}
                    onRowContextMenu={handleRowContextMenu}
                    onToggleSelection={selection.toggleSelection}
                    onOpenConversation={openConversation}
                    onRequestDelete={requestDelete}
                    selectedIds={selection.selectedIds}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      <DestructiveConfirmDialog
        open={confirmTargets !== null}
        onOpenChange={handleConfirmOpenChange}
        action="Delete"
        itemNoun="conversation"
        itemNames={confirmTargets?.map(c => c.title) ?? []}
        showList={false}
        warning="This cannot be undone."
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}

interface ConversationRowProps {
  conv: Conversation;
  isSelected: boolean;
  isFocused: boolean;
  isOpening: boolean;
  dimmed: boolean;
  anyOpening: boolean;
  multiSelected: boolean;
  selectedCount: number;
  selectedIds: Set<string>;
  onRowClick: (e: React.MouseEvent, id: string) => void;
  onRowContextMenu: (id: string) => void;
  onToggleSelection: (id: string) => void;
  onOpenConversation: (id: string) => Promise<void>;
  onRequestDelete: (ids: string[]) => void;
}

function ConversationRow({
  conv,
  isSelected,
  isFocused,
  isOpening,
  dimmed,
  anyOpening,
  multiSelected,
  selectedCount,
  selectedIds,
  onRowClick,
  onRowContextMenu,
  onToggleSelection,
  onOpenConversation,
  onRequestDelete,
}: ConversationRowProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => onRowClick(e, conv.id),
    [onRowClick, conv.id],
  );
  const handleContextMenu = useCallback(
    () => onRowContextMenu(conv.id),
    [onRowContextMenu, conv.id],
  );
  const handleCheckedChange = useCallback(
    () => onToggleSelection(conv.id),
    [onToggleSelection, conv.id],
  );
  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);
  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRequestDelete([conv.id]);
  }, [onRequestDelete, conv.id]);
  const handleOpen = useCallback(() => {
    void onOpenConversation(conv.id);
  }, [onOpenConversation, conv.id]);
  const handleCopyTitle = useCallback(() => {
    void copyText(conv.title, 'Title copied');
  }, [conv.title]);
  const handleContextDelete = useCallback(() => {
    onRequestDelete(multiSelected ? [...selectedIds] : [conv.id]);
  }, [onRequestDelete, multiSelected, selectedIds, conv.id]);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          role="option"
          aria-selected={isSelected}
          data-focused={isFocused || undefined}
          className={
            'group/conv flex items-center gap-3 px-4 py-3 ' +
            (anyOpening ? 'cursor-default ' : 'cursor-pointer ') +
            (isSelected
              ? 'bg-accent/70 hover:bg-accent'
              : 'hover:bg-accent') +
            (isFocused ? ' ring-1 ring-inset ring-primary/40' : '') +
            (dimmed ? ' opacity-40 pointer-events-none' : '')
          }
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        >
          {/* Per-row select checkbox — toggles this conversation
              in the delete selection without opening it. */}
          <Checkbox
            checked={isSelected}
            onCheckedChange={handleCheckedChange}
            onClick={handleCheckboxClick}
            aria-label={`Select ${conv.title}`}
            className="shrink-0"
          />
          <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center shrink-0">
            {isOpening ? (
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
            ) : (
              <MessageSquare className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="truncate text-sm font-medium">{conv.title}</div>
            <div className="text-xs text-muted-foreground truncate">
              {conv.model ?? conv.providerKind ?? 'Unknown'}
              {' · '}
              {new Date(conv.updatedAt).toLocaleString()}
            </div>
          </div>
          {/* Per-row delete — visible on hover (and always on
              touch). Stops propagation so it doesn't open the
              conversation. */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/conv:opacity-100 focus:opacity-100 transition-opacity"
            title="Delete conversation"
            aria-label={`Delete ${conv.title}`}
            onClick={handleDeleteClick}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleOpen}>
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyTitle}>
          Copy title
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleContextDelete}>
          {multiSelected
            ? `Delete ${selectedCount} conversations`
            : 'Delete'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
