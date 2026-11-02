import { useCallback, useEffect, useRef, useState } from 'react';
import type { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  ensureTableStructure,
  getCachedTableStructure,
  useConnectionsSelector,
} from '../../state/connections';
import { registerQueryCompletion } from './hooks';

interface EditorCompletionOptions {
  connectionId: string;
  adapterKey?: string;
  dialect?: string;
  language: string;
  defaultSchema?: string;
}

/**
 * Table/column autocomplete for a DDL editor (routine, trigger) bound to a
 * connection. Pass the returned handler to `<Editor onMount>`. The provider
 * answers only for this editor's model, like the query editor's.
 */
export function useEditorCompletion(opts: EditorCompletionOptions) {
  const [mounted, setMounted] = useState<{ editor: editor.IStandaloneCodeEditor; monaco: Monaco } | null>(null);
  const schemas = useConnectionsSelector((s) => s.schemasById.get(opts.connectionId));
  const schemasRef = useRef(schemas ?? []);
  schemasRef.current = schemas ?? [];
  const defaultSchemaRef = useRef(opts.defaultSchema);
  defaultSchemaRef.current = opts.defaultSchema;
  const { connectionId, adapterKey, dialect, language } = opts;

  useEffect(() => {
    if (!mounted) return;
    const { editor: ed, monaco } = mounted;
    const registration = registerQueryCompletion({
      monaco,
      adapterKey,
      dialect,
      language,
      connectionId,
      defaultSchema: () => defaultSchemaRef.current,
      getSchemas: () => schemasRef.current,
      getCachedStructure: (schema, table) => getCachedTableStructure(connectionId, schema, table),
      ensureStructure: (schema, table) => ensureTableStructure(connectionId, schema, table),
      ownsModel: (model) => model === ed.getModel(),
    });
    return () => registration?.dispose();
  }, [mounted, connectionId, adapterKey, dialect, language]);

  return useCallback((ed: editor.IStandaloneCodeEditor, monaco: Monaco) => setMounted({ editor: ed, monaco }), []);
}
