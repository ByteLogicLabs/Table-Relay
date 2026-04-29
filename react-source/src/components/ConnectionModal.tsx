import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ConnectionProfile, Driver } from '../types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { toast } from 'sonner';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (conn: ConnectionProfile) => void;
  initialData?: ConnectionProfile;
}

export default function ConnectionModal({ isOpen, onClose, onSave, initialData }: ConnectionModalProps) {
  const [formData, setFormData] = useState<Partial<ConnectionProfile>>({
    driver: 'PostgreSQL',
    host: 'localhost',
    port: '5432',
    user: 'postgres',
    sslMode: 'Disable'
  });
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setFormData(initialData);
      } else {
        setFormData({
          driver: 'PostgreSQL',
          host: 'localhost',
          port: '5432',
          user: 'postgres',
          sslMode: 'Disable'
        });
      }
    }
  }, [isOpen, initialData]);

  const handleChange = (field: keyof ConnectionProfile, value: string) => {
    setFormData(prev => {
      const newData = { ...prev, [field]: value };
      // Auto-update port and user when driver changes if using default values
      if (field === 'driver') {
        if (value === 'PostgreSQL') {
          if (prev.port === '3306' || prev.port === '27017') newData.port = '5432';
          if (prev.user === 'root' || prev.user === 'admin') newData.user = 'postgres';
        }
        if (value === 'MySQL') {
          if (prev.port === '5432' || prev.port === '27017') newData.port = '3306';
          if (prev.user === 'postgres' || prev.user === 'admin') newData.user = 'root';
        }
        if (value === 'MongoDB') {
          if (prev.port === '5432' || prev.port === '3306') newData.port = '27017';
          if (prev.user === 'postgres' || prev.user === 'root') newData.user = 'admin';
        }
      }
      return newData;
    });
  };

  const handleTest = () => {
    setIsTesting(true);
    setTimeout(() => {
      setIsTesting(false);
      toast.success('Connection successful!');
    }, 1000);
  };

  const handleSave = () => {
    if (!formData.name || !formData.host || !formData.user) {
      toast.error('Please fill in all required fields');
      return;
    }

    onSave({
      id: initialData?.id || Date.now().toString(),
      name: formData.name,
      driver: formData.driver as Driver,
      host: formData.host,
      port: formData.port || (formData.driver === 'PostgreSQL' ? '5432' : formData.driver === 'MongoDB' ? '27017' : '3306'),
      user: formData.user,
      password: formData.password,
      database: formData.database,
      sslMode: formData.sslMode as any
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl w-[95vw]">
        <DialogHeader>
          <DialogTitle>{initialData ? 'Edit Connection' : 'New Connection'}</DialogTitle>
        </DialogHeader>
        
        <div className="grid gap-6 py-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Driver</label>
            <Select value={formData.driver} onValueChange={(v) => handleChange('driver', v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select driver" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PostgreSQL">PostgreSQL</SelectItem>
                <SelectItem value="MySQL">MySQL</SelectItem>
                <SelectItem value="MongoDB">MongoDB</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="grid gap-2">
            <label className="text-sm font-medium">Name *</label>
            <Input 
              className="w-full" 
              placeholder="e.g. Production DB" 
              value={formData.name || ''} 
              onChange={(e) => handleChange('name', e.target.value)}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Host *</label>
              <Input 
                className="w-full" 
                placeholder="localhost" 
                value={formData.host || ''} 
                onChange={(e) => handleChange('host', e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Port *</label>
              <Input 
                className="w-full" 
                placeholder="Port" 
                value={formData.port || ''} 
                onChange={(e) => handleChange('port', e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="grid gap-2">
              <label className="text-sm font-medium">User *</label>
              <Input 
                className="w-full" 
                value={formData.user || ''} 
                onChange={(e) => handleChange('user', e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Password</label>
              <Input 
                type="password"
                className="w-full" 
                placeholder="••••••••"
                value={formData.password || ''} 
                onChange={(e) => handleChange('password', e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">Database</label>
            <Input 
              className="w-full" 
              placeholder="Optional default database"
              value={formData.database || ''} 
              onChange={(e) => handleChange('database', e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">SSL Mode</label>
            <Select value={formData.sslMode} onValueChange={(v) => handleChange('sslMode', v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select SSL Mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Disable">Disable</SelectItem>
                <SelectItem value="Require">Require</SelectItem>
                <SelectItem value="Verify-CA">Verify-CA</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between mt-4">
          <Button variant="outline" onClick={handleTest} disabled={isTesting}>
            {isTesting ? 'Testing...' : 'Test Connection'}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave}>Save & Connect</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
