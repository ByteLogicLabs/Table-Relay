import { useCallback, useRef, useState } from 'react';

export type SelectionId = string;

export type MultiSelectionState = {
  selectedIds: Set<SelectionId>;
  focusedId: SelectionId | null;
  anchorId: SelectionId | null;
};

export type MultiSelectionHandlers = {
  clearSelection: () => void;
  selectOnly: (id: SelectionId) => void;
  toggleSelection: (id: SelectionId) => void;
  selectRange: (id: SelectionId) => void;
  selectAll: (ids: SelectionId[]) => void;
  setFocus: (id: SelectionId | null) => void;
};

export type UseMultiSelectionResult = MultiSelectionState & MultiSelectionHandlers;

export function useMultiSelection(
  orderedIds: () => SelectionId[],
): UseMultiSelectionResult {
  const [selectedIds, setSelectedIds] = useState<Set<SelectionId>>(() => new Set());
  const [focusedId, setFocusedId] = useState<SelectionId | null>(null);
  const [anchorId, setAnchorId] = useState<SelectionId | null>(null);

  const orderedIdsRef = useRef(orderedIds);
  orderedIdsRef.current = orderedIds;

  const clearSelection = useCallback(() => {
    // Bail out when there's nothing to clear so callers in useEffect deps
    // don't trigger render → effect → setState → render loops.
    setSelectedIds(prev => (prev.size === 0 ? prev : new Set()));
    setAnchorId(prev => (prev === null ? prev : null));
  }, []);

  const selectOnly = useCallback((id: SelectionId) => {
    setSelectedIds(new Set([id]));
    setFocusedId(id);
    setAnchorId(id);
  }, []);

  const toggleSelection = useCallback((id: SelectionId) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setFocusedId(id);
    setAnchorId(id);
  }, []);

  const selectRange = useCallback((id: SelectionId) => {
    const ids = orderedIdsRef.current();
    const anchor = anchorId ?? focusedId ?? id;
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    if (a === -1 || b === -1) {
      selectOnly(id);
      return;
    }
    const [start, end] = a <= b ? [a, b] : [b, a];
    setSelectedIds(new Set(ids.slice(start, end + 1)));
    setFocusedId(id);
  }, [anchorId, focusedId, selectOnly]);

  const selectAll = useCallback((ids: SelectionId[]) => {
    setSelectedIds(new Set(ids));
    if (ids.length > 0) {
      setAnchorId(ids[0]);
      setFocusedId(ids[ids.length - 1]);
    }
  }, []);

  const setFocus = useCallback((id: SelectionId | null) => {
    setFocusedId(id);
  }, []);

  return {
    selectedIds,
    focusedId,
    anchorId,
    clearSelection,
    selectOnly,
    toggleSelection,
    selectRange,
    selectAll,
    setFocus,
  };
}
