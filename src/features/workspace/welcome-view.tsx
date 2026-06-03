import { useState, useEffect } from 'react';
import { ConnectionProfile } from '../../types';
import { Button, buttonVariants } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Search, Plus, Settings, Database, MoreVertical, Edit, Copy, Trash2 } from 'lucide-react';
import ConnectionModal from '../connections/connection-modal';
import SettingsDialog from '../settings/settings-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '../../components/ui/dropdown-menu';
import { toast } from 'sonner';
import MacWindowControls from './mac-window-controls';
import DbIcon from '../../components/db-icon';
import { useConnections } from '../../state/connections';

interface WelcomeViewProps {
  connections: ConnectionProfile[];
  onConnect: (id: string) => void;
  onAddConnection: (conn: ConnectionProfile) => void;
  onEditConnection: (conn: ConnectionProfile) => void;
  onDeleteConnection: (id: string) => void;
}

export default function WelcomeView({ 
  connections, 
  onConnect, 
  onAddConnection, 
  onEditConnection, 
  onDeleteConnection 
}: WelcomeViewProps) {
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionProfile | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const connState = useConnections();

  // The Settings dialog normally lives in the connection rail, but the rail
  // isn't mounted on this welcome screen — so the native menu "Settings…"
  // (⌘+,) and the in-app gear button had nothing to open. Host a dialog here
  // and listen for the same `tablerelay:open-settings` event the rail uses.
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('tablerelay:open-settings', handler);
    return () => window.removeEventListener('tablerelay:open-settings', handler);
  }, []);

  const filteredConnections = connections.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase()) || 
    c.host.toLowerCase().includes(search.toLowerCase())
  );

  const handleConnect = (id: string) => {
    // Kicks off the real connect in app.tsx, which drives the
    // store's `connectingIds` set we read from below.
    onConnect(id);
  };

  const handleDuplicate = (conn: ConnectionProfile) => {
    const newConn = { ...conn, id: Date.now().toString(), name: `${conn.name} (Copy)` };
    onAddConnection(newConn);
    toast.success('Connection duplicated');
  };

  const favoriteConnections = connections.filter(c => c.isFavorite);
  const hasFavorites = favoriteConnections.length > 0;

  return (
    <div className="flex-1 flex bg-background relative mac-vibrancy">
      {/* Sidebar area with custom traffic-light controls. */}
      {hasFavorites && (
        <div className="w-64 border-r border-border/50 flex flex-col bg-sidebar-bg/50 shrink-0">
          <MacWindowControls />
          <div className="p-4 flex-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">Favorites</h2>
            <div className="space-y-1">
              {favoriteConnections.map(conn => (
                <div 
                  key={conn.id}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 rounded-md cursor-pointer text-sm"
                  onClick={() => handleConnect(conn.id)}
                >
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: conn.color || '#888' }} />
                  <span className="truncate">{conn.name}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="p-4 border-t border-border/50 flex justify-between items-center">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <div
          data-tauri-drag-region
          className={`h-14 border-b border-border/50 flex items-center justify-end pr-6 ${
            // No "Connections" heading here — it collided with / sat awkwardly
            // beside the macOS traffic lights. The header is now just a drag
            // region carrying the search + Add Connection controls on the right.
            // Still reserve left clearance for the traffic lights (78px = the
            // rail's RAIL_COLLAPSED_WIDTH) when there's no Favorites sidebar to
            // cover that corner.
            hasFavorites ? 'pl-6' : 'pl-19.5'
          }`}
        >
          <div className="flex items-center gap-4">
            <div className="relative w-64">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input 
                placeholder="Search connections..." 
                className="pl-9 h-8 bg-muted/50 border-none focus-visible:ring-1"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={() => { setEditingConnection(undefined); setIsModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              Add Connection
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {connections.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <Database className="w-16 h-16 mb-4 opacity-20" />
              <p className="text-lg font-medium mb-2">No connections yet</p>
              <p className="text-sm mb-6">Add a database connection to get started.</p>
              <Button onClick={() => { setEditingConnection(undefined); setIsModalOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" />
                Add Connection
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredConnections.map(conn => (
                <div 
                  key={conn.id}
                  className="group bg-card border border-border rounded-xl p-4 hover:shadow-md transition-all cursor-pointer relative"
                  onClick={() => handleConnect(conn.id)}
                >
                  {connState.connectingIds.has(conn.id) && (
                    <div className="absolute inset-0 bg-background/80 backdrop-blur-sm rounded-xl flex items-center justify-center z-10">
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs font-medium">Connecting...</span>
                      </div>
                    </div>
                  )}
                  
                  <div className="flex justify-between items-start mb-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                      <DbIcon driver={conn.driver} className="w-5 h-5" />
                    </div>
                    
                    <DropdownMenu>
                      <DropdownMenuTrigger 
                        className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity' })} 
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }}>
                          Connect
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => { 
                          e.stopPropagation(); 
                          onEditConnection({ ...conn, isFavorite: !conn.isFavorite }); 
                        }}>
                          {conn.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setEditingConnection(conn); setIsModalOpen(true); }}>
                          <Edit className="w-4 h-4 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDuplicate(conn); }}>
                          <Copy className="w-4 h-4 mr-2" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          className="text-destructive focus:text-destructive"
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            if (confirm(`Are you sure you want to delete '${conn.name}'?`)) {
                              onDeleteConnection(conn.id);
                            }
                          }}
                        >
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  
                  <h3 className="font-semibold text-base mb-1 truncate">{conn.name}</h3>
                  <div className="text-sm text-muted-foreground flex flex-col gap-1">
                    <span className="truncate">{conn.user}@{conn.host}:{conn.port}</span>
                    <span className="text-xs px-2 py-0.5 bg-muted rounded-md w-fit">{conn.driver}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConnectionModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        onSave={(conn) => {
          if (editingConnection) {
            onEditConnection(conn);
          } else {
            onAddConnection(conn);
          }
          setIsModalOpen(false);
        }}
        initialData={editingConnection}
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
