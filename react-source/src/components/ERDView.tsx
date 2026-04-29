import React, { useCallback, useMemo } from 'react';
import { 
  ReactFlow, 
  Controls, 
  Background, 
  useNodesState, 
  useEdgesState, 
  MarkerType,
  Handle,
  Position
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Mock generation for ERD based on schema name
const generateMockNodesAndEdges = (schemaName: string) => {
  // Let's create a few tables for 'public'
  const nodes = [
    {
      id: 'users',
      type: 'tableNode',
      position: { x: 50, y: 50 },
      data: {
        label: 'users',
        columns: [
          { name: 'id', type: 'integer', isPrimary: true },
          { name: 'name', type: 'varchar' },
          { name: 'email', type: 'varchar', isUnique: true },
        ]
      }
    },
    {
      id: 'orders',
      type: 'tableNode',
      position: { x: 400, y: 50 },
      data: {
        label: 'orders',
        columns: [
          { name: 'id', type: 'integer', isPrimary: true },
          { name: 'user_id', type: 'integer', isForeign: true },
          { name: 'total', type: 'decimal' },
          { name: 'created_at', type: 'timestamp' }
        ]
      }
    },
    {
      id: 'products',
      type: 'tableNode',
      position: { x: 50, y: 300 },
      data: {
        label: 'products',
        columns: [
          { name: 'id', type: 'integer', isPrimary: true },
          { name: 'name', type: 'varchar' },
          { name: 'price', type: 'decimal' }
        ]
      }
    },
    {
      id: 'order_items',
      type: 'tableNode',
      position: { x: 400, y: 300 },
      data: {
        label: 'order_items',
        columns: [
          { name: 'id', type: 'integer', isPrimary: true },
          { name: 'order_id', type: 'integer', isForeign: true },
          { name: 'product_id', type: 'integer', isForeign: true },
          { name: 'quantity', type: 'integer' }
        ]
      }
    }
  ];

  const edges = [
    {
      id: 'e-users-orders',
      source: 'users',
      target: 'orders',
      sourceHandle: 'right',
      targetHandle: 'left',
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 2, stroke: '#888' },
    },
    {
      id: 'e-orders-order_items',
      source: 'orders',
      target: 'order_items',
      sourceHandle: 'bottom',
      targetHandle: 'top',
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 2, stroke: '#888' },
    },
    {
      id: 'e-products-order_items',
      source: 'products',
      target: 'order_items',
      sourceHandle: 'right',
      targetHandle: 'left',
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 2, stroke: '#888' },
    }
  ];

  return { initialNodes: nodes, initialEdges: edges };
};

const TableNode = ({ data, isConnectable }: any) => {
  return (
    <div className="bg-background border border-border shadow-md rounded-md overflow-hidden min-w-[200px] text-sm font-sans">
      <Handle type="target" position={Position.Left} id="left" style={{ background: '#555', opacity: 0 }} isConnectable={isConnectable} />
      <Handle type="target" position={Position.Top} id="top" style={{ background: '#555', opacity: 0 }} isConnectable={isConnectable} />
      
      <div className="bg-muted px-3 py-2 border-b border-border font-medium flex items-center justify-between">
        <span>{data.label}</span>
      </div>
      <div className="flex flex-col">
        {data.columns.map((col: any, idx: number) => (
          <div key={idx} className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 last:border-0 hover:bg-muted/10">
            <div className="flex items-center gap-2">
              {col.isPrimary && <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" title="Primary Key" />}
              {col.isForeign && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" title="Foreign Key" />}
              {col.isUnique && <span className="w-1.5 h-1.5 rounded-full bg-purple-500" title="Unique Index" />}
              {!col.isPrimary && !col.isForeign && !col.isUnique && <span className="w-1.5 h-1.5 rounded-full bg-transparent" />}
              <span className="font-mono text-xs">{col.name}</span>
            </div>
            <span className="text-muted-foreground text-xs">{col.type}</span>
          </div>
        ))}
      </div>

      <Handle type="source" position={Position.Right} id="right" style={{ background: '#555', opacity: 0 }} isConnectable={isConnectable} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: '#555', opacity: 0 }} isConnectable={isConnectable} />
    </div>
  );
};

export default function ERDView({ schemaName }: { schemaName: string }) {
  const { initialNodes, initialEdges } = useMemo(() => generateMockNodesAndEdges(schemaName), [schemaName]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes as any);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges as any);
  
  const nodeTypes = useMemo(() => ({ tableNode: TableNode }), []);

  return (
    <div className="w-full h-full bg-muted/5 relative">
      <div className="absolute top-0 left-0 right-0 h-12 border-b border-border bg-muted/10 flex items-center px-4 z-10">
        <h2 className="font-medium text-sm">
          Entity-Relationship Diagram: <span className="text-primary font-mono">{schemaName}</span>
        </h2>
      </div>
      <div className="w-full h-full pt-12">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          attributionPosition="bottom-right"
        >
          <Background color="#aaa" gap={16} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
