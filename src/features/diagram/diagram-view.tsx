import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { Key, KeyRound, Link2, Hash, Shield, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { db, type TableStructure, type ForeignKey, isDbError } from '../../lib/db';
import { ensureTableStructure, primeTableStructure, refreshSchemas } from '../../state/connections';

export interface DiagramViewProps {
  connectionId: string;
  scope: 'table' | 'schema';
  /** Required when scope === 'table' */
  schemaName: string;
  /** Required when scope === 'table' */
  tableName?: string;
}

interface DiagramTableData {
  structure: TableStructure;
  isFocus: boolean;
}

function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  // Split into connected components so isolated tables don't pile up in one
  // vertical column next to the connected graph.
  const adj = new Map<string, Set<string>>();
  nodes.forEach(n => adj.set(n.id, new Set()));
  edges.forEach(e => {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  });
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id];
    const comp: string[] = [];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      comp.push(id);
      adj.get(id)?.forEach(x => stack.push(x));
    }
    components.push(comp);
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const heightOf = (n: Node) => 54 + (n.data as { structure: TableStructure }).structure.columns.length * 26;
  const WIDTH = 260;
  const GAP_X = 140;
  const GAP_Y = 90;

  const positioned: Node[] = [];
  let cursorX = 0;
  let rowTop = 0;
  let rowHeight = 0;
  const MAX_ROW_WIDTH = Math.max(1800, Math.sqrt(nodes.length) * (WIDTH + GAP_X) * 1.4);

  // Sort components by size so the big connected graph lands first.
  components.sort((a, b) => b.length - a.length);

  for (const comp of components) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: 'LR',
      nodesep: 80,
      ranksep: 140,
      marginx: 20,
      marginy: 20,
      ranker: 'network-simplex',
    });
    g.setDefaultEdgeLabel(() => ({}));
    comp.forEach(id => {
      const n = nodeById.get(id)!;
      g.setNode(id, { width: WIDTH, height: heightOf(n) });
    });
    edges
      .filter(e => comp.includes(e.source) && comp.includes(e.target))
      .forEach(e => g.setEdge(e.source, e.target));
    dagre.layout(g);

    // Translate this component so its bounding box sits at (cursorX, rowTop).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    comp.forEach(id => {
      const { x, y, width, height } = g.node(id);
      minX = Math.min(minX, x - width / 2);
      minY = Math.min(minY, y - height / 2);
      maxX = Math.max(maxX, x + width / 2);
      maxY = Math.max(maxY, y + height / 2);
    });
    const compW = maxX - minX;
    const compH = maxY - minY;

    // Wrap to next row if this component wouldn't fit horizontally.
    if (cursorX > 0 && cursorX + compW > MAX_ROW_WIDTH) {
      cursorX = 0;
      rowTop += rowHeight + GAP_Y;
      rowHeight = 0;
    }

    const dx = cursorX - minX;
    const dy = rowTop - minY;
    comp.forEach(id => {
      const { x, y, width, height } = g.node(id);
      const base = nodeById.get(id)!;
      positioned.push({
        ...base,
        position: { x: x + dx - width / 2, y: y + dy - height / 2 },
      });
    });

    cursorX += compW + GAP_X;
    rowHeight = Math.max(rowHeight, compH);
  }

  return positioned;
}

function formatRowCount(n: number | null): string {
  if (n === null || n === undefined) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const TableNode = ({ data, isConnectable }: { data: DiagramTableData; isConnectable?: boolean }) => {
  const { structure, isFocus } = data;

  return (
    <div
      className={`bg-background shadow-md rounded-md overflow-hidden w-65 text-sm font-sans border ${
        isFocus ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border'
      }`}
    >
      <Handle type="target" position={Position.Left} id="t-left" style={{ opacity: 0 }} isConnectable={isConnectable} />
      <Handle type="source" position={Position.Right} id="t-right" style={{ opacity: 0 }} isConnectable={isConnectable} />

      <div
        className={`px-3 py-2 border-b border-border flex items-center justify-between ${
          isFocus ? 'bg-primary/10 text-primary' : 'bg-muted'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Shield className="w-3.5 h-3.5 shrink-0 opacity-70" />
          <span className="font-medium truncate">{structure.name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {structure.rowCount !== null && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-background/60 text-muted-foreground">
              {formatRowCount(structure.rowCount)} rows
            </span>
          )}
          {isFocus && (
            <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/20">
              current
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col">
        {structure.columns.map(col => (
          <div
            key={col.name}
            className="relative flex items-center justify-between px-3 py-1.5 border-b border-border/50 last:border-0 hover:bg-muted/20"
          >
            <Handle type="target" position={Position.Left} id={`col-${col.name}-left`} style={{ opacity: 0, top: '50%' }} isConnectable={isConnectable} />
            <Handle type="source" position={Position.Right} id={`col-${col.name}-right`} style={{ opacity: 0, top: '50%' }} isConnectable={isConnectable} />

            <div className="flex items-center gap-2 min-w-0">
              {col.isPrimary ? (
                <Key className="w-3 h-3 text-primary shrink-0" aria-label="primary key" />
              ) : col.isForeign ? (
                <Link2 className="w-3 h-3 text-muted-foreground shrink-0" aria-label="foreign key" />
              ) : col.isUnique ? (
                <KeyRound className="w-3 h-3 text-primary/70 shrink-0" aria-label="unique" />
              ) : col.isIndexed ? (
                <Hash className="w-3 h-3 text-muted-foreground/60 shrink-0" aria-label="indexed" />
              ) : (
                <span className="w-3 h-3 shrink-0" aria-hidden />
              )}
              <span className={`font-mono text-xs truncate ${col.isPrimary ? 'text-primary' : ''}`}>
                {col.name}
              </span>
              {!col.nullable && !col.isPrimary && (
                <span className="text-[9px] text-muted-foreground/70 font-mono">NN</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-muted-foreground text-[11px] font-mono">
                {col.dataType}
                {col.length ? `(${col.length})` : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

interface LoadedGraph {
  focusName: string;
  structures: TableStructure[];
  relations: ForeignKey[];
}

// Irregular English plurals we see regularly in schemas. Extend as needed.
const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  foot: 'feet',
  tooth: 'teeth',
  goose: 'geese',
  mouse: 'mice',
  ox: 'oxen',
};
const IRREGULAR_SINGULARS: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_PLURALS).map(([s, p]) => [p, s]),
);

/**
 * Enumerate plural candidates for a singular English noun. Ordered from most
 * likely to least likely (callers pick the first that exists in-schema).
 */
function pluralCandidates(base: string): string[] {
  if (!base) return [];
  const lower = base.toLowerCase();
  const out: string[] = [];
  if (IRREGULAR_PLURALS[lower]) out.push(IRREGULAR_PLURALS[lower]);
  // "company" → "companies", "category" → "categories"
  if (/[^aeiou]y$/i.test(base)) out.push(base.slice(0, -1) + 'ies');
  // "knife" → "knives", "leaf" → "leaves"
  if (/[^aeiou](fe|f)$/i.test(base)) out.push(base.replace(/fe?$/i, 'ves'));
  // "box" → "boxes", "bus" → "buses", "match" → "matches"
  if (/(s|x|z|ch|sh)$/i.test(base)) out.push(base + 'es');
  // "city" → "cities" is already in IRREGULAR path via `y$`; this fallback
  // covers the normal "order" → "orders" case.
  out.push(base + 's');
  // Same name (rare but real — e.g. "data", "equipment", or a schema that
  // just uses singular table names like Rails' `--skip-pluralize-tables`).
  out.push(base);
  return Array.from(new Set(out));
}

/**
 * Enumerate singular candidates for a plural English noun. Inverse of
 * `pluralCandidates` — used when inferring what `<table>_id` column shape
 * to look for on *other* tables that might reference this one.
 */
function singularCandidates(plural: string): string[] {
  if (!plural) return [];
  const lower = plural.toLowerCase();
  const out: string[] = [];
  if (IRREGULAR_SINGULARS[lower]) out.push(IRREGULAR_SINGULARS[lower]);
  // "companies" → "company", "categories" → "category"
  if (/ies$/i.test(plural)) out.push(plural.slice(0, -3) + 'y');
  // "knives" → "knife", "leaves" → "leaf"
  if (/ves$/i.test(plural)) out.push(plural.slice(0, -3) + 'fe');
  // "boxes" → "box", "buses" → "bus" (two-char strip)
  if (/(ses|xes|zes|ches|shes)$/i.test(plural)) out.push(plural.slice(0, -2));
  // "orders" → "order"
  if (/s$/i.test(plural)) out.push(plural.slice(0, -1));
  // Already singular or uncountable
  out.push(plural);
  return Array.from(new Set(out));
}

/**
 * Guess the referenced table name from a `<name>_id` column. Returns a list
 * ordered from most likely to least likely. Handles common plural patterns
 * (Laravel/Rails conventions) plus common table-name prefixes (`wp_`, `tbl_`,
 * app-specific prefixes).
 */
function guessTableFromFkColumn(col: string, schemaPrefixes: string[] = []): string[] {
  if (!col.endsWith('_id') || col === '_id') return [];
  const base = col.slice(0, -3);
  // If column already looks plural (e.g. `categories_id`), don't double-pluralize.
  const looksPlural = /(s|ies|ves|es)$/i.test(base);
  const basics = looksPlural
    ? Array.from(new Set([base, ...singularCandidates(base)]))
    : pluralCandidates(base);
  // Expand with each known prefix so `user_id` maps to `wp_users` too.
  const out: string[] = [];
  for (const c of basics) {
    out.push(c);
    for (const prefix of schemaPrefixes) {
      if (prefix) out.push(prefix + c);
    }
  }
  return Array.from(new Set(out));
}

/**
 * Infer likely table-name prefixes used by this schema (e.g. `wp_`, `tbl_`,
 * `app_`). We pick prefixes that appear on at least ~60% of tables or on 5+
 * tables — enough to be a real convention, not a coincidence.
 */
function detectSchemaPrefixes(tableNames: string[]): string[] {
  if (tableNames.length < 4) return [];
  const counts = new Map<string, number>();
  for (const name of tableNames) {
    const m = name.match(/^([a-z][a-z0-9]{0,6}_)/i);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const threshold = Math.max(5, Math.floor(tableNames.length * 0.6));
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .map(([p]) => p);
}

async function loadTableGraph(connectionId: string, schema: string, table: string): Promise<LoadedGraph> {
  // Fire all three root fetches in parallel — they're independent, and over
  // SSH each one costs ~1s of round-trip. Serial would stack to ~3s.
  // `ensureTableStructure` lets a cached structure from the sidebar / data
  // grid skip the network entirely.
  // Schema-wide relations capture every FK in the schema; focus.foreignKeys
  // has the same info for the focus row but some MySQL configs miss
  // cross-schema references so we union both sources below.
  const [focus, schemaRelations, allSchemas] = await Promise.all([
    ensureTableStructure(connectionId, schema, table),
    db.listRelations(connectionId, schema).catch(() => [] as ForeignKey[]),
    db.listSchemas(connectionId).catch(() => []),
  ]);
  const schemaTables = allSchemas.find(s => s.name === schema)?.tables ?? [];
  const schemaTableNames = new Set(schemaTables.map(t => t.name));
  const schemaPrefixes = detectSchemaPrefixes(schemaTables.map(t => t.name));

  // Build a relation set that includes:
  //   - every outbound FK straight from describe_table (authoritative for
  //     the focus row) — e.g. jobs.company_id → companies.id
  //   - every schema-wide FK that references the focus — e.g.
  //     job_details.job_id → jobs.id
  const fkKey = (fk: ForeignKey) =>
    `${fk.fromSchema}.${fk.fromTable}.${fk.fromColumns.join(',')}->${fk.toSchema}.${fk.toTable}.${fk.toColumns.join(',')}`;
  const relationMap = new Map<string, ForeignKey>();
  for (const fk of focus.foreignKeys) relationMap.set(fkKey(fk), fk);
  for (const fk of schemaRelations) {
    if (fk.fromTable === table || fk.toTable === table) relationMap.set(fkKey(fk), fk);
  }

  // === Inference pass 1: outbound edges from focus ===
  // Many Laravel-style schemas declare `*_id` columns without SQL foreign
  // key constraints — the app layer enforces integrity instead. Draw those
  // as best-effort edges so the diagram reflects the real data model.
  for (const col of focus.columns) {
    if (!col.name.endsWith('_id') || col.name === 'id') continue;
    const alreadyLinked = Array.from(relationMap.values()).some(fk =>
      fk.fromTable === table && fk.fromColumns.includes(col.name),
    );
    if (alreadyLinked) continue;
    const candidates = guessTableFromFkColumn(col.name, schemaPrefixes);
    const match = candidates.find(c => schemaTableNames.has(c) && c !== table) ?? null;
    if (!match) continue;
    const inferred: ForeignKey = {
      name: `inferred:${table}.${col.name}->${match}.id`,
      fromSchema: schema,
      fromTable: table,
      fromColumns: [col.name],
      toSchema: schema,
      toTable: match,
      toColumns: ['id'],
    };
    relationMap.set(fkKey(inferred), inferred);
  }

  // === Inference pass 2: inbound edges targeting focus ===
  // Find tables that have a `<focus_singular>_id` column with no real FK to
  // this table. E.g. focus=`jobs` → look for any table with a `job_id`
  // column that isn't already linked. We describe each candidate table
  // lazily (only when a name match is possible) to keep this cheap.
  const focusSingulars = singularCandidates(table)
    // Also strip detected prefixes so focus=`wp_users` → also try `user_id`.
    .flatMap(s => {
      const variants = [s];
      for (const prefix of schemaPrefixes) {
        if (s.startsWith(prefix)) variants.push(s.slice(prefix.length));
      }
      return variants;
    })
    .filter(s => s && s !== table);
  const expectedFkColumns = new Set(focusSingulars.map(s => `${s}_id`));

  // Candidate-pool: every other table in-schema. We describe them all so
  // inbound FK inference is exhaustive, but fire in chunks sized to the
  // backend pool (16 connections) so the driver doesn't have to queue
  // dozens of parallel acquires.
  const candidateInboundTables = [...schemaTableNames].filter((t): t is string => typeof t === 'string' && t !== table);
  const INBOUND_CHUNK = 12;
  const inboundByName = new Map<string, TableStructure>();
  for (let i = 0; i < candidateInboundTables.length; i += INBOUND_CHUNK) {
    const batch = candidateInboundTables.slice(i, i + INBOUND_CHUNK);
    const results = await Promise.all(
      batch.map(n => ensureTableStructure(connectionId, schema, n).catch(() => null)),
    );
    for (const s of results) if (s) inboundByName.set(s.name, s);
  }

  for (const [otherName, other] of inboundByName) {
    for (const col of other.columns) {
      if (!expectedFkColumns.has(col.name)) continue;
      const alreadyLinked = Array.from(relationMap.values()).some(fk =>
        fk.fromTable === otherName && fk.fromColumns.includes(col.name) && fk.toTable === table,
      );
      if (alreadyLinked) continue;
      const inferred: ForeignKey = {
        name: `inferred:${otherName}.${col.name}->${table}.id`,
        fromSchema: schema,
        fromTable: otherName,
        fromColumns: [col.name],
        toSchema: schema,
        toTable: table,
        toColumns: ['id'],
      };
      relationMap.set(fkKey(inferred), inferred);
    }
  }

  const relations = Array.from(relationMap.values());

  // One hop in each direction:
  //   - outbound: tables the focus depends on (jobs → companies)
  //   - inbound:  tables that depend on the focus (job_details → jobs)
  const neighbourNames = new Set<string>();
  for (const fk of relations) {
    if (fk.fromTable === table) neighbourNames.add(fk.toTable);
    if (fk.toTable === table) neighbourNames.add(fk.fromTable);
  }
  neighbourNames.delete(table);

  // Reuse inbound describes; only fetch the ones we didn't already probe.
  const missing = [...neighbourNames].filter(n => !inboundByName.has(n));
  const fetchedExtra = await Promise.all(
    missing.map(n => ensureTableStructure(connectionId, schema, n).catch(() => null)),
  );
  for (const s of fetchedExtra) if (s) inboundByName.set(s.name, s);

  const structures: TableStructure[] = [focus];
  for (const name of neighbourNames) {
    const s = inboundByName.get(name);
    if (s) structures.push(s);
  }

  return {
    focusName: table,
    structures,
    relations,
  };
}

async function loadSchemaGraph(connectionId: string, schema: string): Promise<LoadedGraph> {
  // Bulk path: one `db_describe_schema` call (3 info_schema queries on the
  // Rust side) replaces what used to be N × `describe_table` — each table
  // costing 4 info_schema queries. For a 30-table schema over SSH this
  // dropped from ~120 round-trips to 3.
  //
  // `list_relations` is subsumed by the FK data on each returned structure,
  // but we still want `listSchemas` to run in parallel so we know which
  // tables exist in the schema (in case describe_schema hits a row-level
  // permission issue and drops some).
  const [structures, schemas] = await Promise.all([
    db.describeSchema(connectionId, schema),
    db.listSchemas(connectionId).catch(() => []),
  ]);
  // Warm the structure cache so a later click on a Structure tab is an
  // instant hit instead of another round-trip.
  for (const s of structures) {
    primeTableStructure(connectionId, s);
  }
  // Union every outbound FK from the bulk result. Same-schema FKs already
  // cover the whole graph since we're rendering a single schema.
  const relations: ForeignKey[] = [];
  for (const s of structures) {
    for (const fk of s.foreignKeys) relations.push(fk);
  }
  // Keep the schema-info around in case later code paths want a table list
  // that includes names the bulk describe skipped (e.g. views returned with
  // no columns). Today we don't use it beyond logging.
  void schemas;
  return {
    focusName: schema,
    structures,
    relations,
  };
}

export default function DiagramView({ connectionId, scope, schemaName, tableName }: DiagramViewProps) {
  const [graph, setGraph] = useState<LoadedGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumping this triggers a reload. Driven by the user-facing Retry button
  // and the `dbtable:reload` event listener.
  const [reloadTick, setReloadTick] = useState(0);
  const requestReload = () => setReloadTick(t => t + 1);

  useEffect(() => {
    let cancelled = false;
    // Timeouts on large schemas are usually transient — a backed-up connection
    // pool or a slow information_schema query. One quick retry on timeout
    // typically succeeds and saves the user from hitting Retry manually.
    const load = async () => {
      const attempt = async () => scope === 'schema'
        ? await loadSchemaGraph(connectionId, schemaName)
        : await loadTableGraph(connectionId, schemaName, tableName ?? '');
      setLoading(true);
      setError(null);
      try {
        let loaded: LoadedGraph;
        try {
          loaded = await attempt();
        } catch (err) {
          if (isDbError(err) && err.kind === 'Timeout' && !cancelled) {
            await new Promise(r => setTimeout(r, 400));
            loaded = await attempt();
          } else {
            throw err;
          }
        }
        if (!cancelled) setGraph(loaded);
      } catch (err) {
        if (!cancelled) setError(isDbError(err) ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    // Rebuild the diagram when WorkspaceView (or any caller) broadcasts that
    // this connection's schema may have changed — e.g. Generate ERD fires
    // this, and so does saving a table structure.
    const onReload = (e: Event) => {
      const ce = e as CustomEvent<{ connectionId: string | null }>;
      const target = ce.detail?.connectionId;
      if (target && target !== connectionId) return;
      requestReload();
    };
    window.addEventListener('dbtable:reload', onReload);
    return () => {
      cancelled = true;
      window.removeEventListener('dbtable:reload', onReload);
    };
  }, [connectionId, scope, schemaName, tableName, reloadTick]);

  const focusName = scope === 'schema' ? schemaName : (tableName ?? '');

  const { initialNodes, initialEdges } = useMemo(() => {
    if (!graph) return { initialNodes: [] as Node[], initialEdges: [] as Edge[] };
    const focusId = scope === 'schema' ? null : graph.focusName;

    const rawNodes: Node[] = graph.structures.map(s => ({
      id: s.name,
      type: 'tableNode',
      position: { x: 0, y: 0 },
      data: { structure: s, isFocus: s.name === focusId },
    }));

    const knownIds = new Set(rawNodes.map(n => n.id));
    const edges: Edge[] = [];

    for (const fk of graph.relations) {
      if (!knownIds.has(fk.fromTable) || !knownIds.has(fk.toTable)) continue;
      const touchesFocus = focusId !== null && (fk.fromTable === focusId || fk.toTable === focusId);
      const fromCol = fk.fromColumns[0];
      const toCol = fk.toColumns[0];
      const fromUnique = graph.structures
        .find(s => s.name === fk.fromTable)?.columns
        .find(c => c.name === fromCol)?.isUnique ?? false;
      // Inferred relations (synthesized from *_id naming conventions when
      // the schema has no real FK) render dashed with a subtle label so the
      // user can tell guesses from declared constraints.
      const isInferred = fk.name.startsWith('inferred:');
      // In schema-wide scope there is no "focus" row, so every real FK gets
      // the same emphasized treatment (animated + primary color) as focused
      // edges in table scope. Inferred edges stay static + dashed in both
      // modes so they remain visually distinct from declared constraints.
      const highlight = touchesFocus || (focusId === null && !isInferred);
      edges.push({
        id: `${fk.fromTable}.${fromCol}->${fk.toTable}.${toCol}`,
        source: fk.fromTable,
        sourceHandle: `col-${fromCol}-right`,
        target: fk.toTable,
        targetHandle: `col-${toCol}-left`,
        type: 'smoothstep',
        animated: highlight && !isInferred,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        label: isInferred
          ? (fromUnique ? '1 — 1 · inferred' : '1 — * · inferred')
          : (fromUnique ? '1 — 1' : '1 — *'),
        labelStyle: {
          fontSize: 10,
          fill: isInferred ? 'var(--muted-foreground, #999)' : 'var(--muted-foreground, #666)',
          fontStyle: isInferred ? 'italic' : 'normal',
        },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: 'var(--background, #fff)', fillOpacity: 0.9 },
        style: {
          strokeWidth: highlight ? 1.8 : 1.2,
          stroke: highlight ? 'var(--primary, #6366f1)' : '#9aa0a6',
          strokeDasharray: isInferred ? '6 4' : undefined,
          opacity: isInferred ? 0.75 : 1,
        },
      });
    }

    return { initialNodes: layoutGraph(rawNodes, edges), initialEdges: edges };
  }, [graph, scope]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const nodeTypes = useMemo(() => ({ tableNode: TableNode }), []);

  // Sync computed layout into ReactFlow state whenever the source graph changes.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const stats = useMemo(() => ({ tables: nodes.length, relations: edges.length }), [nodes.length, edges.length]);

  const scopeLabel = scope === 'schema' ? 'Schema diagram' : 'Table diagram';

  if (loading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading diagram…</span>
        <span className="text-[11px] opacity-70">Large schemas may take up to a minute</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="w-5 h-5 text-destructive" />
        <div className="text-sm font-medium text-destructive">Failed to build diagram</div>
        <div className="text-xs text-muted-foreground max-w-md wrap-break-word">{error}</div>
        <button
          type="button"
          onClick={requestReload}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted/40 text-foreground"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-muted/5 relative">
      <div className="absolute top-2 left-3 right-3 z-10 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-2 text-xs text-muted-foreground pointer-events-auto bg-background/70 backdrop-blur px-2.5 py-1 rounded-md border border-border/50">
          <Shield className="w-3.5 h-3.5" />
          <span className="font-medium text-foreground">{focusName}</span>
          <span className="opacity-60">·</span>
          <span>{scopeLabel}</span>
          <button
            type="button"
            onClick={() => {
              // Kick the connections-store schema cache so any subsequent
              // read sees the fresh list, then broadcast a reload so the
              // diagram itself and siblings (sidebar, autocomplete, etc.)
              // rebuild from current server state.
              void refreshSchemas(connectionId);
              window.dispatchEvent(new CustomEvent('dbtable:reload', {
                detail: { connectionId },
              }));
            }}
            className="ml-1 p-1 rounded hover:bg-muted hover:text-foreground"
            title="Regenerate diagram from fresh schema"
            aria-label="Reload diagram"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground pointer-events-auto bg-background/70 backdrop-blur px-2.5 py-1 rounded-md border border-border/50">
          <span>{stats.tables} tables</span>
          <span className="opacity-40">|</span>
          <span>{stats.relations} relations</span>
        </div>
      </div>

      <div className="absolute bottom-3 left-3 z-10 bg-background/80 backdrop-blur border border-border/50 rounded-md px-2.5 py-1.5 text-[10px] text-muted-foreground flex items-center gap-3">
        <span className="flex items-center gap-1"><Key className="w-3 h-3 text-primary" /> PK</span>
        <span className="flex items-center gap-1"><Link2 className="w-3 h-3" /> FK</span>
        <span className="flex items-center gap-1"><KeyRound className="w-3 h-3 text-primary/70" /> Unique</span>
        <span className="flex items-center gap-1"><Hash className="w-3 h-3 opacity-60" /> Indexed</span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="hsl(var(--muted-foreground) / 0.35)" gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          zoomable
          pannable
          // High-contrast palette: the map backdrop uses the deepest surface,
          // node fills pick up the accent (primary) for the focused table and
          // near-foreground for the rest so tables read clearly against the
          // backdrop. Mask is pure black at 70% so the viewport cutout is
          // unambiguous instead of the earlier near-invisible overlay.
          maskColor="rgba(0, 0, 0, 0.7)"
          bgColor="hsl(var(--sidebar-bg, 220 15% 8%))"
          nodeStrokeWidth={3}
          nodeStrokeColor="hsl(var(--primary))"
          nodeColor={(n) =>
            (n.data as unknown as DiagramTableData)?.isFocus
              ? 'hsl(var(--primary))'
              : 'hsl(var(--foreground) / 0.9)'
          }
          style={{
            border: '1px solid hsl(var(--border))',
            borderRadius: 6,
            backgroundColor: 'hsl(var(--sidebar-bg, 220 15% 8%))',
          }}
        />
      </ReactFlow>
    </div>
  );
}
