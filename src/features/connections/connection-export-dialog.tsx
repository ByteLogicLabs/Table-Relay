import { useCallback, useEffect, useRef, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import ExportModal, { type ExportConfig } from '../data-grid/export-modal';
import { runExport, exportFileMeta, type ExportDialect } from '../data-grid/export-data';
import { isDbError, type SchemaInfo } from '../../lib/db';
import { refreshSchemas } from '../../state/connections';
import ProgressDialog, { type ProgressState, type ProgressLogLine } from '../../components/ui/progress-dialog';

/**
 * Connection-level Export — the same multi-table picker the data grid uses, but
 * launched from the connection menu with no open table tab. Pick any tables in
 * the schema and stream them to disk (CSV / JSON / SQL, gzip, split), with a
 * progress popup (per-table %, live log, cancel).
 */
export default function ConnectionExportDialog({
  isOpen,
  onClose,
  connectionId,
  schemas,
  initialSchema,
  dialect,
  supportsSql,
}: {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string | null;
  schemas: SchemaInfo[];
  initialSchema?: string | null;
  dialect: ExportDialect;
  supportsSql: boolean;
}) {
  const cancelRef = useRef(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);

  useEffect(() => {
    if (!isOpen || !connectionId) return;
    if (schemas.length === 0) void refreshSchemas(connectionId, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, connectionId]);

  const firstSchema = initialSchema || schemas[0]?.name || '';
  const firstTable =
    schemas.find((s) => s.name === firstSchema)?.tables.find((t) => t.kind !== 'view')?.name ?? '';

  const handleExport = async (config: ExportConfig) => {
    if (!connectionId) {
      toast.error('No active connection to export from');
      return;
    }
    const { defaultPath, filter } = exportFileMeta(config);
    const path = await saveDialog({ title: 'Export data', defaultPath, filters: [filter] });
    if (!path) return;

    cancelRef.current = false;
    const log: ProgressLogLine[] = [];
    const total = config.targets.length;
    const objects =
      config.views.length + config.routines.length + config.triggers.length;
    // Track the base step label so the log gets one line per object/table.
    let lastLabel = '';

    const update = (patch: Partial<ProgressState>) =>
      setProgress((prev) => ({
        step: prev?.step ?? '',
        fraction: prev?.fraction ?? null,
        phase: prev?.phase ?? 'running',
        detail: prev?.detail,
        ...patch,
        log: [...log],
      }));

    update({ step: 'Starting export…', fraction: 0 });

    try {
      const parts = await runExport({
        connectionId,
        dialect,
        config,
        path,
        splitBytes: config.splitMb != null ? config.splitMb * 1024 * 1024 : null,
        cancelRef,
        // runExport reports ONE overall fraction across every table + object.
        onProgress: ({ fraction, label, detail }) => {
          if (label !== lastLabel) {
            lastLabel = label;
            log.push({ text: `→ ${label}` });
          }
          update({
            step: cancelRef.current
              ? 'Cancelling… (finishing current page)'
              : label,
            fraction,
            detail,
          });
        },
      });

      if (cancelRef.current) {
        log.push({ text: 'Cancelled — partial file(s) written.', kind: 'error' });
        update({ step: 'Cancelled', phase: 'cancelled', fraction: null });
        return;
      }
      const bits = [
        total ? `${total} ${total === 1 ? 'table' : 'tables'}` : null,
        objects ? `${objects} object${objects === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      const what = bits.join(' + ') || 'data';
      const extras = [config.gzip ? 'gzip' : null, parts > 1 ? `${parts} parts` : null].filter(Boolean);
      log.push({ text: `Done — exported ${what}${extras.length ? ` (${extras.join(', ')})` : ''}`, kind: 'success' });
      update({ step: 'Export complete', phase: 'done', fraction: 1 });
      toast.success(`Exported ${what}`);
    } catch (err) {
      const msg = isDbError(err) ? err.message : String(err);
      log.push({ text: `Error: ${msg}`, kind: 'error' });
      update({ step: 'Export failed', phase: 'error' });
      toast.error(`Export failed: ${msg}`);
    }
  };

  const progressRunning = progress?.phase === 'running';

  const handleProgressCancel = useCallback(() => {
    cancelRef.current = true;
    // Immediate feedback — the loop stops at the next row/page boundary,
    // which can lag a moment behind a slow in-flight query.
    setProgress((p) =>
      p && p.phase === 'running'
        ? { ...p, step: 'Cancelling… (finishing current page)' }
        : p,
    );
  }, []);

  const handleProgressClose = useCallback(() => {
    if (progressRunning) return;
    setProgress(null);
    onClose();
  }, [progressRunning, onClose]);

  return (
    <>
      <ExportModal
        isOpen={isOpen && !progress}
        onClose={onClose}
        connectionId={connectionId}
        schemas={schemas}
        initialSchema={firstSchema}
        initialTable={firstTable}
        supportsUpdateIfExists={dialect !== null}
        supportsSql={supportsSql}
        onExport={handleExport}
      />
      <ProgressDialog
        open={progress !== null}
        title="Export Data"
        state={progress}
        onCancel={handleProgressCancel}
        onClose={handleProgressClose}
      />
    </>
  );
}
