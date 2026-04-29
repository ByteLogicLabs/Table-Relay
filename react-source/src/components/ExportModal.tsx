import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Checkbox } from './ui/checkbox';
import { Download } from 'lucide-react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  onExport: (config: any) => void;
}

export default function ExportModal({ isOpen, onClose, tableName, onExport }: ExportModalProps) {
  const [format, setFormat] = useState('csv');
  const [dbType, setDbType] = useState('mysql');
  const [exportType, setExportType] = useState('both');
  const [dropTable, setDropTable] = useState(false);

  const handleExport = () => {
    onExport({
      format,
      ...(format === 'sql' ? { dbType, exportType, dropTable } : {})
    });
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Export Data</DialogTitle>
          <DialogDescription>
            Export data from <span className="font-mono bg-muted px-1 rounded">{tableName}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="format" className="text-right">
              Format
            </Label>
            <div className="col-span-3">
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger id="format">
                  <SelectValue placeholder="Select format" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="excel">Excel (.xlsx)</SelectItem>
                  <SelectItem value="sql">SQL</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {format === 'sql' && (
            <>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="dbType" className="text-right">
                  DB Syntax
                </Label>
                <div className="col-span-3">
                  <Select value={dbType} onValueChange={setDbType}>
                    <SelectTrigger id="dbType">
                      <SelectValue placeholder="Select Database" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mysql">MySQL</SelectItem>
                      <SelectItem value="postgresql">PostgreSQL</SelectItem>
                      <SelectItem value="sqlite">SQLite</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="exportType" className="text-right">
                  Export
                </Label>
                <div className="col-span-3">
                  <Select value={exportType} onValueChange={setExportType}>
                    <SelectTrigger id="exportType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="data">Data Only (INSERTs)</SelectItem>
                      <SelectItem value="structure">Structure Only (DDL)</SelectItem>
                      <SelectItem value="both">Structure and Data</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-4 items-start gap-4">
                <div className="col-start-2 col-span-3">
                  <div className="flex items-center space-x-2">
                    <Checkbox 
                      id="dropTable" 
                      checked={dropTable} 
                      onCheckedChange={(c) => setDropTable(c === true)} 
                    />
                    <Label htmlFor="dropTable" className="text-sm font-normal cursor-pointer text-muted-foreground">
                      Add DROP TABLE IF EXISTS statement
                    </Label>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleExport}>
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
