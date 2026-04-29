import { useState } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ConnectionProfile } from '../types';
import { Plus, Tag, Layers, KeySquare, Edit2, Save, Trash2, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';

interface SchemaViewProps {
  tableName: string;
  connection: ConnectionProfile;
  isNew?: boolean;
}

// Mock schema data
const generateMockSchema = (tableName: string) => {
  return [
    { name: 'id', type: 'integer', length: '-', nullable: 'NO', default: 'nextval()', key: 'PRI' },
    { name: 'name', type: 'varchar', length: '255', nullable: 'NO', default: 'NULL', key: '' },
    { name: 'email', type: 'varchar', length: '255', nullable: 'NO', default: 'NULL', key: 'UNI' },
    { name: 'status', type: 'varchar', length: '50', nullable: 'YES', default: "'active'", key: '' },
    { name: 'created_at', type: 'timestamp', length: '-', nullable: 'NO', default: 'CURRENT_TIMESTAMP', key: '' },
  ];
};

const generateMockIndexes = () => {
  return [
    { name: 'PRIMARY', type: 'BTREE', columns: 'id', unique: 'Yes' },
    { name: 'users_email_idx', type: 'BTREE', columns: 'email', unique: 'Yes' },
    { name: 'users_status_idx', type: 'BTREE', columns: 'status', unique: 'No' },
  ];
};

export default function SchemaView({ tableName, connection, isNew }: SchemaViewProps) {
  const isMongo = connection.driver === 'MongoDB';
  
  const [isEditing, setIsEditing] = useState(isNew || false);
  const [editTableName, setEditTableName] = useState(tableName === 'untitled_table' ? '' : tableName);
  const [columns, setColumns] = useState(() => (isNew ? [] : generateMockSchema(tableName)).map(c => ({...c, id: Math.random().toString()})));
  const [originalColumns, setOriginalColumns] = useState(columns);
  
  const [indexes] = useState(generateMockIndexes);

  const handleSave = () => {
    setIsEditing(false);
    setOriginalColumns(columns);
    toast.success(isNew ? 'Table created successfully' : 'Table structure updated');
  };

  const handleCancel = () => {
    setColumns(originalColumns);
    setEditTableName(tableName === 'untitled_table' ? '' : tableName);
    setIsEditing(false);
  };

  const handleAddColumn = () => {
    const newCol = { id: Math.random().toString(), name: 'new_column', type: 'varchar', length: '255', nullable: 'YES', default: '', key: '' };
    setColumns([...columns, newCol]);
    if (!isEditing) setIsEditing(true);
  };

  const handleRemoveColumn = (id: string) => {
    setColumns(columns.filter(c => c.id !== id));
  };

  const updateColumn = (id: string, field: string, value: string) => {
    setColumns(columns.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="h-12 border-b border-border flex items-center justify-between px-4 bg-muted/10">
        <h2 className="font-medium text-sm flex items-center">
          {isMongo ? 'Collection:' : 'Table:'}
          {isEditing ? (
            <Input
              value={editTableName}
              onChange={e => setEditTableName(e.target.value)}
              placeholder="table_name"
              className="ml-2 h-7 w-48 font-mono text-sm border-transparent focus-visible:ring-1 bg-background shadow-sm"
              autoFocus={isNew}
            />
          ) : (
            <span className="text-primary font-mono ml-2">{editTableName}</span>
          )}
        </h2>
        
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button size="sm" onClick={handleSave} className="bg-green-600 hover:bg-green-700 text-white h-7">
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancel} className="h-7 text-destructive hover:bg-destructive/10 hover:text-destructive">
                <X className="w-3.5 h-3.5 mr-1" /> Discard
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setIsEditing(true)} className="h-7">
              <Edit2 className="w-3.5 h-3.5 mr-1" /> Edit Structure
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 flex flex-col">
        <Tabs defaultValue="columns" className="flex flex-col h-full">
          <div className="flex justify-between items-center mb-4">
            <TabsList>
              <TabsTrigger value="columns" className="px-4">
                <Layers className="w-4 h-4 mr-2" />
                {isMongo ? 'Validation Schema' : 'Columns'}
              </TabsTrigger>
              <TabsTrigger value="indexes" className="px-4">
                <Tag className="w-4 h-4 mr-2" />
                Indexes
              </TabsTrigger>
              {!isMongo && (
                <TabsTrigger value="foreign_keys" className="px-4">
                  <KeySquare className="w-4 h-4 mr-2" />
                  Foreign Keys
                </TabsTrigger>
              )}
            </TabsList>
            
            <Button size="sm" variant="outline" onClick={handleAddColumn}>
              <Plus className="w-4 h-4 mr-2" />
              {isMongo ? 'Add Rule / Field' : 'Add Column'}
            </Button>
          </div>

          <TabsContent value="columns" className="flex-1 overflow-hidden flex flex-col border border-border rounded-md m-0">
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm text-left border-collapse">
                <thead className="text-xs text-muted-foreground uppercase bg-muted sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Name</th>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Type</th>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Length</th>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Nullable</th>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Default</th>
                    <th className="px-4 py-2 border-b border-border font-medium whitespace-nowrap">Key</th>
                    {isEditing && <th className="px-2 py-2 border-b border-border w-10"></th>}
                  </tr>
                </thead>
                <tbody>
                  {columns.length === 0 ? (
                    <tr>
                      <td colSpan={isEditing ? 7 : 6} className="text-center p-8 text-muted-foreground">
                        No columns defined. Click "Add Column" to begin.
                      </td>
                    </tr>
                  ) : columns.map((col) => (
                    <tr key={col.id} className={`border-b border-border transition-colors ${isEditing ? 'bg-muted/5' : 'hover:bg-muted/20'}`}>
                      <td className="p-0 border-r border-border font-mono font-medium text-foreground whitespace-nowrap">
                        {isEditing ? (
                          <input
                            type="text"
                            value={col.name}
                            onChange={(e) => updateColumn(col.id, 'name', e.target.value)}
                            className="w-full h-full min-h-[32px] px-3 py-1 bg-transparent border-0 focus:ring-1 focus:ring-primary outline-none font-mono text-xs"
                            placeholder="column_name"
                          />
                        ) : (
                          <div className="px-4 py-2 w-full h-full">
                            {col.name}
                          </div>
                        )}
                      </td>
                      <td className="p-0 border-r border-border text-muted-foreground whitespace-nowrap">
                        {isEditing ? (
                          <select
                            value={col.type}
                            onChange={(e) => updateColumn(col.id, 'type', e.target.value)}
                            className="w-full h-full min-h-[32px] px-3 py-1 bg-transparent border-0 focus:ring-1 focus:ring-primary outline-none text-xs"
                          >
                            <option value="varchar">varchar</option>
                            <option value="integer">integer</option>
                            <option value="bigint">bigint</option>
                            <option value="text">text</option>
                            <option value="boolean">boolean</option>
                            <option value="timestamp">timestamp</option>
                            <option value="json">json</option>
                            <option value="uuid">uuid</option>
                          </select>
                        ) : (
                          <div className="px-4 py-2 w-full h-full">
                            {col.type}
                          </div>
                        )}
                      </td>
                      <td className="p-0 border-r border-border text-muted-foreground whitespace-nowrap">
                        {isEditing ? (
                          <input
                            type="text"
                            value={col.length}
                            onChange={(e) => updateColumn(col.id, 'length', e.target.value)}
                            className="w-full h-full min-h-[32px] px-3 py-1 bg-transparent border-0 focus:ring-1 focus:ring-primary outline-none font-mono text-xs"
                            placeholder="-"
                          />
                        ) : (
                          <div className="px-4 py-2 w-full h-full">
                            {col.length}
                          </div>
                        )}
                      </td>
                      <td className="p-0 border-r border-border text-muted-foreground whitespace-nowrap">
                        {isEditing ? (
                          <select
                            value={col.nullable}
                            onChange={(e) => updateColumn(col.id, 'nullable', e.target.value)}
                            className="w-full h-full min-h-[32px] px-3 py-1 bg-transparent border-0 focus:ring-1 focus:ring-primary outline-none text-xs"
                          >
                            <option value="YES">YES</option>
                            <option value="NO">NO</option>
                          </select>
                        ) : (
                          <div className="px-4 py-2 w-full h-full">
                            {col.nullable}
                          </div>
                        )}
                      </td>
                      <td className="p-0 border-r border-border font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {isEditing ? (
                          <input
                            type="text"
                            value={col.default}
                            onChange={(e) => updateColumn(col.id, 'default', e.target.value)}
                            className="w-full h-full min-h-[32px] px-3 py-1 bg-transparent border-0 focus:ring-1 focus:ring-primary outline-none font-mono text-xs text-muted-foreground"
                            placeholder="NULL"
                          />
                        ) : (
                          <div className="px-4 py-2 w-full h-full text-muted-foreground">
                            {col.default}
                          </div>
                        )}
                      </td>
                      <td className={`p-0 border-border whitespace-nowrap ${!isEditing ? 'border-r-0' : 'border-r'}`}>
                        {isEditing ? (
                          <select
                            value={col.key}
                            onChange={(e) => updateColumn(col.id, 'key', e.target.value)}
                            className="w-full h-full min-h-[32px] px-3 py-1 bg-transparent border-0 focus:ring-1 focus:ring-primary outline-none text-xs text-muted-foreground"
                          >
                            <option value="">-</option>
                            <option value="PRI">PRIMARY</option>
                            <option value="UNI">UNIQUE</option>
                          </select>
                        ) : (
                          <div className="px-4 py-2 w-full h-full flex items-center">
                            {col.key === 'PRI' && <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 text-xs font-medium">PRIMARY</span>}
                            {col.key === 'UNI' && <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-400 text-xs font-medium">UNIQUE</span>}
                          </div>
                        )}
                      </td>
                      {isEditing && (
                        <td className="p-0 border-border whitespace-nowrap">
                          <div className="flex items-center justify-center h-full min-h-[32px]">
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => handleRemoveColumn(col.id)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          <TabsContent value="indexes" className="flex-1 overflow-hidden flex flex-col border border-border rounded-md m-0">
             <div className="flex-1 overflow-auto">
              <table className="w-full text-sm text-left border-collapse">
                <thead className="text-xs text-muted-foreground uppercase bg-muted sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Index Name</th>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Type</th>
                    <th className="px-4 py-2 border-b border-r border-border font-medium whitespace-nowrap">Columns</th>
                    <th className="px-4 py-2 border-b border-border font-medium whitespace-nowrap">Unique</th>
                  </tr>
                </thead>
                <tbody>
                  {indexes.map((idx) => (
                    <tr key={idx.name} className="border-b border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2 border-r border-border font-mono font-medium text-foreground whitespace-nowrap">
                        {idx.name}
                      </td>
                      <td className="px-4 py-2 border-r border-border text-muted-foreground whitespace-nowrap">
                        {idx.type}
                      </td>
                      <td className="px-4 py-2 border-r border-border font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {idx.columns}
                      </td>
                      <td className="px-4 py-2 border-border whitespace-nowrap">
                        {idx.unique === 'Yes' ? (
                          <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-400 text-xs font-medium">Yes</span>
                        ) : (
                          <span className="text-muted-foreground">No</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
          
          <TabsContent value="foreign_keys" className="flex-1 overflow-hidden flex flex-col border border-border rounded-md m-0">
            <div className="flex-1 flex items-center justify-center text-muted-foreground bg-muted/10">
              No foreign keys defined for this table.
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
