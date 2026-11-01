import { ChatArea } from '../components/Chat/ChatArea';
import { SystemPanel } from '../components/Chat/SystemPanel';
import { VoiceModeModal } from '../components/Voice/VoiceModeModal';
import { useAppStore } from '../lib/store';

export function ChatPage() {
  const systemPanelOpen = useAppStore((s) => s.systemPanelOpen);

  return (
    <div className="flex h-full overflow-hidden relative">
      <div className="flex-1 min-w-0">
        <ChatArea />
      </div>
      {systemPanelOpen && <SystemPanel />}
      <VoiceModeModal />
    </div>
  );
}
