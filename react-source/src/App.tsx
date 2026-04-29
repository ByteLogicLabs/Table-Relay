import { useState, useEffect } from 'react';
import { ConnectionProfile } from './types';
import WelcomeView from './components/WelcomeView';
import WorkspaceView from './components/WorkspaceView';
import { Toaster } from './components/ui/sonner';

const DEFAULT_CONNECTIONS: ConnectionProfile[] = [
  {
    id: 'postgres-demo-1',
    name: 'Production DB Primary',
    driver: 'PostgreSQL',
    host: 'db-aws.internal',
    port: 5432,
    database: 'production_main',
    user: 'admin_usr',
    password: '***',
    sshEnabled: false,
    color: '#3498db'
  },
  {
    id: 'mysql-demo-2',
    name: 'Analytics Data Warehouse',
    driver: 'MySQL',
    host: 'analytics.mysql.net',
    port: 3306,
    database: 'analytics_db',
    user: 'read_only_analyst',
    password: '***',
    sshEnabled: false,
    color: '#f39c12'
  },
  {
    id: 'mongo-demo-3',
    name: 'User Sessions Mongo',
    driver: 'MongoDB',
    host: 'cluster0.mongodb.net',
    port: 27017,
    database: 'sessions',
    user: 'mongo_admin',
    password: '***',
    sshEnabled: false,
    color: '#2ecc71'
  }
];

export default function App() {
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [activeConnectionIds, setActiveConnectionIds] = useState<string[]>([]);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Load connections from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('db_connections');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.length > 0) {
          setConnections(parsed);
        } else {
          setConnections(DEFAULT_CONNECTIONS);
        }
      } catch (e) {
        console.error('Failed to parse connections', e);
        setConnections(DEFAULT_CONNECTIONS);
      }
    } else {
      setConnections(DEFAULT_CONNECTIONS);
    }
    
    // Check system preference for dark mode
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setIsDarkMode(true);
      document.documentElement.classList.add('dark');
    }
  }, []);

  // Save connections when they change
  useEffect(() => {
    localStorage.setItem('db_connections', JSON.stringify(connections));
  }, [connections]);

  const handleConnect = (id: string) => {
    setActiveConnectionIds(prev => prev.includes(id) ? prev : [...prev, id]);
  };

  const handleDisconnect = (id: string) => {
    setActiveConnectionIds(prev => prev.filter(cId => cId !== id));
  };

  const handleAddConnection = (conn: ConnectionProfile) => {
    setConnections(prev => [...prev, conn]);
  };

  const handleEditConnection = (conn: ConnectionProfile) => {
    setConnections(prev => prev.map(c => c.id === conn.id ? conn : c));
  };

  const handleDeleteConnection = (id: string) => {
    setConnections(prev => prev.filter(c => c.id !== id));
    setActiveConnectionIds(prev => prev.filter(cId => cId !== id));
  };

  const activeConnections = connections.filter(c => activeConnectionIds.includes(c.id));

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      {/* Simulated macOS Window Shell */}
      <div className="flex-1 flex overflow-hidden relative">
        {activeConnections.length > 0 ? (
          <WorkspaceView 
            activeConnections={activeConnections} 
            onDisconnect={handleDisconnect}
            connections={connections}
            onConnect={handleConnect}
          />
        ) : (
          <WelcomeView 
            connections={connections} 
            onConnect={handleConnect}
            onAddConnection={handleAddConnection}
            onEditConnection={handleEditConnection}
            onDeleteConnection={handleDeleteConnection}
          />
        )}
      </div>
      <Toaster position="top-right" />
    </div>
  );
}
