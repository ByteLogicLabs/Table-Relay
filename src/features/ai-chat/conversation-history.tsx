import { useCallback, useEffect, useState } from 'react';
import { History, Trash2, Loader2, MessageSquare, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { type Conversation } from '../../lib/ai';
import { listConversations, loadConversation, deleteConversation } from '../../state/ai';

interface Props {
  onSelect?: () => void;
}

export function ConversationHistory({ onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listConversations(30);
      setConversations(list);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleSelect = async (id: string) => {
    await loadConversation(id);
    setOpen(false);
    onSelect?.();
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteConversation(id);
    void refresh();
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        title="Chat history"
        aria-label="Chat history"
        onClick={() => setOpen(true)}
      >
        <History className="w-3.5 h-3.5" />
      </Button>

      {open && (
        <div className="absolute inset-0 z-[100] bg-background text-foreground flex flex-col">
          <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-muted/10">
            <div className="flex items-center gap-2 min-w-0">
              <History className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">Chat History</div>
                <div className="text-[10px] text-muted-foreground">
                  Saved conversations
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setOpen(false)}
                title="Close history"
                aria-label="Close history"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            {conversations.length === 0 && !loading && (
              <div className="h-full flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
                No saved conversations
              </div>
            )}
            <div className="max-w-4xl mx-auto w-full divide-y divide-border">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-accent cursor-pointer group"
                  onClick={() => void handleSelect(conv.id)}
                >
                  <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                    <MessageSquare className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">{conv.title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {conv.model ?? conv.providerKind ?? 'Unknown'}
                      {' · '}
                      {new Date(conv.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 opacity-70 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={(e) => void handleDelete(e, conv.id)}
                    title="Delete"
                    aria-label="Delete conversation"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
