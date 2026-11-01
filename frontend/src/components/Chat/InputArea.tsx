import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Send, Square, Paperclip, Search, Heart, Headphones, Mic,
  Monitor, ChevronDown, Folder, Plug2, X, File, Image, BarChart2,
  TrendingUp, FileText, SlidersHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore, generateId } from '../../lib/store';
import { streamChat, streamResearch } from '../../lib/sse';
import { fetchSavings, getBase } from '../../lib/api';
import { listConnectors, getSyncStatus } from '../../lib/connectors-api';
import { serializeToolCallArguments } from '../../lib/tool-call';
import {
  engineFromCompletionChunk,
  resolveChatEngine,
} from '../../lib/chat-telemetry';
import { MicButton } from './MicButton';
import { useSpeech } from '../../hooks/useSpeech';
import type {
  ChatMessage,
  MessageTelemetry,
  ResearchSearchTrace,
  ResearchSource,
  TokenUsage,
  ToolCallInfo,
} from '../../types';

// ── Types ──────────────────────────────────────────────────────────────

type ChatMode = 'search' | 'computer';
type EffortLevel = 'light' | 'balanced' | 'deep';

interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
  status: 'pending' | 'ready' | 'error';
}

// ── Deep Research corpus sync ──────────────────────────────────────────

// While Deep Research is toggled on, poll connected sources for sync
// progress so we can surface "Searching over N items — sync in progress"
// next to the toggle. Polling is gated on `enabled` so toggling DR off
// stops the network chatter immediately.
function useResearchCorpusSync(enabled: boolean): {
  syncing: boolean;
  itemsSynced: number;
} {
  const [state, setState] = useState({ syncing: false, itemsSynced: 0 });

  useEffect(() => {
    if (!enabled) {
      setState({ syncing: false, itemsSynced: 0 });
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const list = await listConnectors();
        const connected = list.filter((c) => c.connected);
        if (connected.length === 0) {
          if (!cancelled) setState({ syncing: false, itemsSynced: 0 });
          return;
        }
        const results = await Promise.all(
          connected.map(async (c) => {
            try {
              return await getSyncStatus(c.connector_id);
            } catch {
              return null;
            }
          }),
        );
        let syncing = false;
        let itemsSynced = 0;
        for (const r of results) {
          if (!r) continue;
          if (r.state === 'syncing') syncing = true;
          itemsSynced += r.items_synced ?? 0;
        }
        if (!cancelled) setState({ syncing, itemsSynced });
      } catch {
        // Network blip — leave previous state intact.
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  return state;
}

// ── Suggestion Chips ───────────────────────────────────────────────────

const SUGGESTION_CHIPS = [
  {
    label: 'Diagnose churn from usage',
    icon: BarChart2,
    prompt:
      'Help me diagnose customer churn using product usage data. First identify the data sources and date range you need, then analyze engagement changes, churn signals, and recommended next steps.',
  },
  {
    label: 'Track MRR movements',
    icon: TrendingUp,
    prompt:
      'Help me track monthly recurring revenue movements, including new, expansion, contraction, churned, and reactivated MRR. Ask for the required billing data and reporting period before calculating.',
  },
  {
    label: 'Ship a weekly changelog',
    icon: FileText,
    prompt:
      'Draft a weekly changelog from my project\'s completed work. Ask for the reporting period and source material, then organize changes into features, improvements, and fixes.',
  },
];

// ── Effort selector ────────────────────────────────────────────────────

const EFFORT_OPTIONS: { value: EffortLevel; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'deep', label: 'Deep' },
];

// ── Plugin registry (minimal) ──────────────────────────────────────────

const BUILT_IN_PLUGINS = [
  { id: 'deep-research', name: 'Deep Research', description: 'Search over connected data sources and synthesize answers.', status: 'connected' as const },
  { id: 'web-search', name: 'Web Search', description: 'Search the web for up-to-date information.', status: 'setup-required' as const },
  { id: 'code-runner', name: 'Code Runner', description: 'Execute code snippets in a sandboxed environment.', status: 'setup-required' as const },
];

// ── Attachment Menu ────────────────────────────────────────────────────

function AttachmentMenu({
  onAdd,
  onClose,
}: {
  onAdd: (files: FileList | null) => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className="absolute bottom-full left-0 mb-2 rounded-xl shadow-lg border overflow-hidden z-50 min-w-[180px]"
      style={{ background: 'var(--color-input-bg)', borderColor: 'var(--color-border)' }}
      role="menu"
      aria-label="Attachment options"
    >
      <button
        type="button"
        role="menuitem"
        className="flex items-center gap-2.5 w-full px-4 py-2.5 text-sm text-left transition-colors cursor-pointer hover:bg-[var(--color-bg-secondary)]"
        style={{ color: 'var(--color-text)' }}
        onClick={() => { fileRef.current?.click(); }}
      >
        <File size={15} style={{ color: 'var(--color-accent)' }} />
        Upload File
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex items-center gap-2.5 w-full px-4 py-2.5 text-sm text-left transition-colors cursor-pointer hover:bg-[var(--color-bg-secondary)]"
        style={{ color: 'var(--color-text)' }}
        onClick={() => { imageRef.current?.click(); }}
      >
        <Image size={15} style={{ color: 'var(--color-accent)' }} />
        Upload Image
      </button>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        multiple
        onChange={(e) => { onAdd(e.target.files); onClose(); }}
      />
      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        className="hidden"
        multiple
        onChange={(e) => { onAdd(e.target.files); onClose(); }}
      />
    </div>
  );
}

// ── Project Picker ─────────────────────────────────────────────────────

const DEMO_PROJECTS = [
  { id: 'proj-1', name: 'Sora AI Chatbot' },
  { id: 'proj-2', name: 'Analytics Dashboard' },
  { id: 'proj-3', name: 'Weekly Reports' },
];

function ProjectPicker({
  selectedId,
  onSelect,
  onClose,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = DEMO_PROJECTS.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      className="absolute bottom-full left-0 mb-2 rounded-xl shadow-lg border overflow-hidden z-50 min-w-[220px]"
      style={{ background: 'var(--color-input-bg)', borderColor: 'var(--color-border)' }}
      role="dialog"
      aria-label="Choose a project"
    >
      <div className="p-2 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects..."
          className="w-full px-3 py-1.5 text-sm rounded-lg outline-none"
          style={{
            background: 'var(--color-bg-secondary)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
          }}
          autoFocus
        />
      </div>
      <div className="max-h-48 overflow-y-auto">
        {selectedId && (
          <button
            type="button"
            className="flex items-center gap-2 w-full px-4 py-2 text-sm cursor-pointer transition-colors hover:bg-[var(--color-bg-secondary)]"
            style={{ color: 'var(--color-text-secondary)' }}
            onClick={() => { onSelect(null); onClose(); }}
          >
            <X size={13} /> Clear selection
          </button>
        )}
        {filtered.length === 0 && (
          <p className="px-4 py-3 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
            No projects found
          </p>
        )}
        {filtered.map((p) => (
          <button
            key={p.id}
            type="button"
            className="flex items-center gap-2 w-full px-4 py-2.5 text-sm cursor-pointer transition-colors hover:bg-[var(--color-bg-secondary)]"
            style={{
              color: selectedId === p.id ? 'var(--color-accent)' : 'var(--color-text)',
              fontWeight: selectedId === p.id ? '600' : undefined,
            }}
            onClick={() => { onSelect(p.id); onClose(); }}
          >
            <Folder size={14} style={{ color: 'var(--color-accent)' }} />
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Plugins Panel ──────────────────────────────────────────────────────

function PluginsPanel({
  enabledIds,
  onToggle,
  onClose,
}: {
  enabledIds: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute bottom-full left-0 mb-2 rounded-xl shadow-lg border overflow-hidden z-50 min-w-[280px]"
      style={{ background: 'var(--color-input-bg)', borderColor: 'var(--color-border)' }}
      role="dialog"
      aria-label="Plugins"
    >
      <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: 'var(--color-border)' }}>
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>Plugins</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded cursor-pointer"
          style={{ color: 'var(--color-text-tertiary)' }}
          aria-label="Close plugins panel"
        >
          <X size={14} />
        </button>
      </div>
      {BUILT_IN_PLUGINS.map((plugin) => {
        const enabled = enabledIds.includes(plugin.id);
        const statusColor =
          plugin.status === 'connected' ? 'var(--color-success)'
          : plugin.status === 'setup-required' ? 'var(--color-warning)'
          : 'var(--color-text-tertiary)';
        const statusLabel =
          plugin.status === 'connected' ? 'Connected'
          : plugin.status === 'setup-required' ? 'Setup required'
          : 'Disconnected';
        return (
          <div
            key={plugin.id}
            className="flex items-start gap-3 px-4 py-3 border-b last:border-b-0"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  {plugin.name}
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: `${statusColor}22`, color: statusColor }}
                >
                  {statusLabel}
                </span>
              </div>
              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                {plugin.description}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={plugin.status === 'setup-required'}
              onClick={() => onToggle(plugin.id)}
              className="mt-0.5 w-9 h-5 rounded-full transition-colors shrink-0 relative cursor-pointer disabled:opacity-40 disabled:cursor-default"
              style={{
                background: enabled ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
              }}
              title={plugin.status === 'setup-required' ? 'Configuration required' : undefined}
            >
              <span
                className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
                style={{ left: enabled ? '1.25rem' : '0.125rem' }}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Main InputArea / ChatComposer ───────────────────────────────────────

export function InputArea() {
  // ── Core chat state ──────────────────────────────────────────────────
  const [input, setInput] = useState('');
  const [companionMode, setCompanionMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Composer UI state ────────────────────────────────────────────────
  const [chatMode, setChatMode] = useState<ChatMode>('computer');
  const [effortLevel, setEffortLevel] = useState<EffortLevel>('light');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [enabledPluginIds, setEnabledPluginIds] = useState<string[]>(['deep-research']);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showEffortMenu, setShowEffortMenu] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // ── Store selectors ──────────────────────────────────────────────────
  const activeId = useAppStore((s) => s.activeId);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const streamState = useAppStore((s) => s.streamState);
  const messages = useAppStore((s) => s.messages);
  const speechEnabled = useAppStore((s) => s.settings.speechEnabled);
  const maxTokens = useAppStore((s) => s.settings.maxTokens);
  const temperature = useAppStore((s) => s.settings.temperature);
  const createConversation = useAppStore((s) => s.createConversation);
  const addMessage = useAppStore((s) => s.addMessage);
  const updateLastAssistant = useAppStore((s) => s.updateLastAssistant);
  const setStreamState = useAppStore((s) => s.setStreamState);
  const resetStream = useAppStore((s) => s.resetStream);
  const modelLoading = useAppStore((s) => s.modelLoading);
  const deepResearch = useAppStore((s) => s.deepResearch);
  const setDeepResearch = useAppStore((s) => s.setDeepResearch);
  const corpusSync = useResearchCorpusSync(deepResearch);
  const isCurrentChatStreaming = streamState.isStreaming && streamState.conversationId === activeId;

  // ── Speech / Mic ─────────────────────────────────────────────────────
  const {
    state: speechState,
    error: speechError,
    available: speechAvailable,
    startRecording,
    stopRecording,
  } = useSpeech();

  // Abort in-flight stream when the user switches models mid-generation.
  // This prevents errors from trying to continue a stream with a stale model.
  const prevModelRef = useRef(selectedModel);
  useEffect(() => {
    if (prevModelRef.current !== selectedModel && streamState.isStreaming) {
      abortRef.current?.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      resetStream();
      abortRef.current = null;
    }
    prevModelRef.current = selectedModel;
  }, [selectedModel, streamState.isStreaming, resetStream]);

  const micDisabled = !speechEnabled || !speechAvailable || streamState.isStreaming;
  const micReason: 'not-enabled' | 'no-backend' | 'streaming' | undefined =
    !speechEnabled ? 'not-enabled'
    : !speechAvailable ? 'no-backend'
    : streamState.isStreaming ? 'streaming'
    : undefined;

  useEffect(() => {
    if (speechError) {
      toast.error(speechError, { duration: 8000 });
    }
  }, [speechError]);

  const handleMicClick = useCallback(async () => {
    if (speechState === 'recording') {
      try {
        const text = await stopRecording();
        if (text) {
          setInput((prev) => (prev ? prev + ' ' + text : text));
        }
      } catch {
        // Error is captured in useSpeech
      }
    } else {
      await startRecording();
    }
  }, [speechState, startRecording, stopRecording]);

  // ── Auto-resize textarea ─────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  // ── Close menus on outside click ─────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-composer-menu]')) {
        setShowAttachMenu(false);
        setShowEffortMenu(false);
        setShowProjectPicker(false);
        setShowPlugins(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Keyboard Escape to close menus ───────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAttachMenu(false);
        setShowEffortMenu(false);
        setShowProjectPicker(false);
        setShowPlugins(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ── Drag and drop ────────────────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  };

  // ── Attachment handling ──────────────────────────────────────────────
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
    Array.from(files).forEach((file) => {
      if (file.size > MAX_SIZE) {
        toast.error(`"${file.name}" exceeds 10 MB limit and was not added.`);
        return;
      }
      const id = generateId();
      const att: Attachment = { id, name: file.name, type: file.type, size: file.size, status: 'pending' };
      setAttachments((prev) => [...prev, att]);

      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id ? { ...a, dataUrl: ev.target?.result as string, status: 'ready' } : a,
            ),
          );
        };
        reader.onerror = () => {
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: 'error' } : a)),
          );
        };
        reader.readAsDataURL(file);
      } else {
        // Non-image: mark ready (content injected as text note in message)
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: 'ready' } : a)),
        );
      }
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const togglePlugin = (id: string) => {
    setEnabledPluginIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  };

  // ── Stop streaming ───────────────────────────────────────────────────
  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    resetStream();
  }, [resetStream]);

  // ── Send message ─────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const content = input.trim();
    if (!content || streamState.isStreaming) return;
    if (!selectedModel) {
      toast.error('Pick a model first (⌘K)');
      return;
    }

    const savedInput = input; // preserve draft in case of error
    setInput('');
    const sentAttachments = [...attachments];
    setAttachments([]);

    let convId = activeId;
    if (!convId) {
      convId = createConversation(selectedModel);
    }

    // Build content with attachment context for text files
    let fullContent = content;
    const textAttachments = sentAttachments.filter(
      (a) => a.status === 'ready' && !a.type.startsWith('image/'),
    );
    if (textAttachments.length > 0) {
      fullContent += '\n\n[Attached files: ' + textAttachments.map((a) => a.name).join(', ') + ']';
    }

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: fullContent,
      timestamp: Date.now(),
    };
    addMessage(convId, userMsg);

    // Build API messages before adding assistant placeholder
    const currentMessages = useAppStore.getState().messages;
    const apiMessages = [
      ...(companionMode
        ? [{
            role: 'system',
            content: 'You are Sora in Companion Mode (Heart-to-Heart). The user is talking directly to you, sharing their personal feelings, emotions, stress, or thoughts. Listen with deep empathy, warmth, validation, and genuine care. Speak as a trusted, comforting companion and friend. Validate their emotions first, offer thoughtful encouragement, and make them feel truly heard.',
          }]
        : []),
      ...currentMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isResearch: deepResearch || undefined,
    };
    addMessage(convId, assistantMsg);

    // Start streaming
    const startTime = Date.now();
    const timer = setInterval(() => {
      setStreamState({ elapsedMs: Date.now() - startTime });
    }, 100);
    timerRef.current = timer;

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulatedContent = '';
    let usage: TokenUsage | undefined;
    let complexity: { score: number; tier: string; suggested_max_tokens: number } | undefined;
    let routedEngine: string | undefined;
    const toolCalls: ToolCallInfo[] = [];
    const researchTraces: ResearchSearchTrace[] = [];
    const researchSourcesByRef = new Map<number, ResearchSource>();
    const flushSources = () =>
      Array.from(researchSourcesByRef.values()).sort((a, b) => a.ref - b.ref);
    let lastFlush = 0;
    let ttftMs: number | undefined;

    setStreamState({
      conversationId: convId,
      isStreaming: true,
      phase: deepResearch ? 'Researching...' : 'Generating...',
      elapsedMs: 0,
      activeToolCalls: [],
      content: '',
    });
    useAppStore.getState().addLogEntry({
      timestamp: Date.now(),
      level: 'info',
      category: 'chat',
      message: deepResearch
        ? `Research: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`
        : `Request: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}" → ${selectedModel}`,
    });

    try {
      if (deepResearch) {
        for await (const ev of streamResearch(
          content,
          selectedModel,
          controller.signal,
        )) {
          if (ev.type === 'search_call') {
            const trace: ResearchSearchTrace = {
              id: generateId(),
              query: ev.arguments?.query ?? '',
              person: ev.arguments?.person,
              timeRange: ev.arguments?.time_range,
              status: 'pending',
            };
            researchTraces.push(trace);
            setStreamState({ phase: `Searching: ${trace.query}` });
            updateLastAssistant(
              convId,
              accumulatedContent,
              undefined,
              undefined,
              undefined,
              undefined,
              [...researchTraces],
              flushSources(),
            );
            useAppStore.getState().addLogEntry({
              timestamp: Date.now(),
              level: 'info',
              category: 'tool',
              message: `Search: "${trace.query}"${trace.person ? ` (person: ${trace.person})` : ''}`,
            });
          } else if (ev.type === 'search_result') {
            const pending = [...researchTraces].reverse().find((t) => t.status === 'pending');
            if (pending) {
              pending.status = 'complete';
              pending.numHits = ev.num_hits;
              pending.topTitles = ev.top_titles;
            }
            if (ev.sources) {
              for (const src of ev.sources) {
                if (src && typeof src.ref === 'number' && !researchSourcesByRef.has(src.ref)) {
                  researchSourcesByRef.set(src.ref, src);
                }
              }
            }
            updateLastAssistant(
              convId,
              accumulatedContent,
              undefined,
              undefined,
              undefined,
              undefined,
              [...researchTraces],
              flushSources(),
            );
          } else if (ev.type === 'synthesis') {
            if (!ttftMs) ttftMs = Date.now() - startTime;
            accumulatedContent += ev.text;
            setStreamState({ content: accumulatedContent, phase: '' });
            const now = Date.now();
            if (now - lastFlush >= 80) {
              updateLastAssistant(
                convId,
                accumulatedContent,
                undefined,
                undefined,
                undefined,
                undefined,
                [...researchTraces],
                flushSources(),
              );
              lastFlush = now;
            }
          } else if (ev.type === 'system_metrics') {
            // Live GPU sample — feed straight to the System panel so Power
            // (W) and Energy (kJ) tick up in real time as the agent runs.
            useAppStore.getState().setLiveEnergy({
              power_w: ev.power_w,
              energy_j: ev.energy_j,
              duration_s: ev.duration_s,
            });
          } else if (ev.type === 'error') {
            // Backend setup/worker failure (Ollama down, planner model
            // missing, KnowledgeStore locked, etc.). Without surfacing the
            // message, the user sees only the generic "No response was
            // generated" fallback and has no way to self-diagnose.
            const msg = ev.message || 'Research failed (no detail provided)';
            accumulatedContent = accumulatedContent
              ? `${accumulatedContent}\n\n**Research stopped:** ${msg}`
              : `**Research failed:** ${msg}`;
            setStreamState({ content: accumulatedContent, phase: '' });
            useAppStore.getState().addLogEntry({
              timestamp: Date.now(),
              level: 'error',
              category: 'chat',
              message: `Deep Research error: ${msg}`,
            });
            toast.error(msg, { duration: 8000 });
          } else if (ev.type === 'done') {
            if (ev.usage) {
              usage = {
                prompt_tokens: ev.usage.prompt_tokens ?? 0,
                completion_tokens: ev.usage.completion_tokens ?? 0,
                total_tokens:
                  ev.usage.total_tokens ??
                  (ev.usage.prompt_tokens ?? 0) +
                    (ev.usage.completion_tokens ?? 0),
              };
              // Optimistically roll this research turn into the session
              // counters so the Session panel updates the moment the
              // stream finishes, regardless of how /v1/savings aggregates
              // research telemetry server-side.
              useAppStore.getState().incrementSavings(usage);
            }
            // Hold the final live numbers visible for a beat so the panel
            // doesn't flash to 0 between the SSE close and the next
            // /v1/telemetry/energy poll picking up the persisted record.
            window.setTimeout(() => {
              useAppStore.getState().setLiveEnergy(null);
            }, 1500);
            break;
          }
        }
      } else {
      for await (const sseEvent of streamChat(
        { model: selectedModel, messages: apiMessages, stream: true, temperature: companionMode ? 0.85 : temperature, max_tokens: maxTokens },
        controller.signal,
      )) {
        const eventName = sseEvent.event;

        if (eventName === 'agent_turn_start') {
          setStreamState({ phase: 'Agent thinking...' });
        } else if (eventName === 'inference_start') {
          setStreamState({ phase: 'Generating...' });
          useAppStore.getState().addLogEntry({
            timestamp: Date.now(), level: 'info', category: 'chat',
            message: `Generating with ${selectedModel}...`,
          });
        } else if (eventName === 'tool_call_start') {
          try {
            const data = JSON.parse(sseEvent.data);
            const tc: ToolCallInfo = {
              id: generateId(),
              tool: data.tool,
              arguments: serializeToolCallArguments(data.arguments),
              status: 'running',
            };
            toolCalls.push(tc);
            setStreamState({
              phase: `Calling ${data.tool}...`,
              activeToolCalls: [...toolCalls],
            });
            updateLastAssistant(convId, accumulatedContent, [...toolCalls]);
            useAppStore.getState().addLogEntry({
              timestamp: Date.now(), level: 'info', category: 'tool',
              message: `Calling ${data.tool}(${serializeToolCallArguments(data.arguments)})`,
            });
          } catch {}
        } else if (eventName === 'tool_call_end') {
          try {
            const data = JSON.parse(sseEvent.data);
            const tc = toolCalls.find(
              (t) => t.tool === data.tool && t.status === 'running',
            );
            if (tc) {
              tc.status = data.success ? 'success' : 'error';
              tc.latency = data.latency;
              tc.result = data.result;
            }
            setStreamState({
              phase: 'Generating...',
              activeToolCalls: [...toolCalls],
            });
            updateLastAssistant(convId, accumulatedContent, [...toolCalls]);
          } catch {}
        } else {
          try {
            const data = JSON.parse(sseEvent.data);
            const delta = data.choices?.[0]?.delta;
            if (data.usage) usage = data.usage;
            if (data.complexity) complexity = data.complexity;
            routedEngine = engineFromCompletionChunk(data) ?? routedEngine;
            if (delta?.content) {
              if (!ttftMs) ttftMs = Date.now() - startTime;
              accumulatedContent += delta.content;
              setStreamState({ content: accumulatedContent, phase: '' });

              const now = Date.now();
              if (now - lastFlush >= 80) {
                updateLastAssistant(
                  convId,
                  accumulatedContent,
                  toolCalls.length > 0 ? [...toolCalls] : undefined,
                );
                lastFlush = now;
              }
            }
            if (data.choices?.[0]?.finish_reason === 'stop') break;
          } catch {}
        }
      }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // User cancelled or model switch — keep whatever was accumulated
        if (!accumulatedContent) accumulatedContent = '(Generation stopped)';
      } else {
        const errMsg = err?.message || String(err);
        accumulatedContent =
          accumulatedContent || `Error: ${errMsg}`;
        useAppStore.getState().addLogEntry({
          timestamp: Date.now(), level: 'error', category: 'chat',
          message: `Stream error: ${errMsg}`,
        });
        // Restore draft on error
        setInput(savedInput);
        setAttachments(sentAttachments);
      }
      // If we tore out mid-research, make sure the live System panel
      // numbers don't get stuck on the last sample.
      useAppStore.getState().setLiveEnergy(null);
    } finally {
      if (!accumulatedContent) {
        accumulatedContent = 'No response was generated. Please try again.';
      }
      const totalMs = Date.now() - startTime;
      const appState = useAppStore.getState();
      const selectedOwner = appState.models.find((m) => m.id === selectedModel)?.owned_by;
      const engineLabel = resolveChatEngine({
        routedEngine,
        serverEngine: appState.serverInfo?.engine,
        selectedModel,
        selectedOwner,
      });
      const telemetry: MessageTelemetry = {
        engine: engineLabel,
        model_id: selectedModel,
        total_ms: totalMs,
        ttft_ms: ttftMs,
        tokens_per_sec: usage?.completion_tokens
          ? usage.completion_tokens / (totalMs / 1000)
          : undefined,
        complexity_score: complexity?.score,
        complexity_tier: complexity?.tier,
        suggested_max_tokens: complexity?.suggested_max_tokens,
      };
      // Check if the response has digest audio available
      let audioMeta: { url: string } | undefined;
      try {
        const digestRes = await fetch(`${getBase()}/api/digest`);
        if (digestRes.ok) {
          const digest = await digestRes.json();
          if (digest.audio_available) {
            audioMeta = { url: `${getBase()}/api/digest/audio` };
          }
        }
      } catch {
        // Not a digest response or server unavailable — skip
      }

      updateLastAssistant(
        convId,
        accumulatedContent,
        toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        telemetry,
        audioMeta,
        researchTraces.length > 0 ? researchTraces : undefined,
        researchSourcesByRef.size > 0 ? flushSources() : undefined,
      );
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      resetStream();
      useAppStore.getState().addLogEntry({
        timestamp: Date.now(), level: 'info', category: 'chat',
        message: `Response: ${accumulatedContent.length} chars`,
      });
      abortRef.current = null;

      // Research path updates session counters optimistically from the
      // `done` event's usage payload — re-fetching here would overwrite
      // it with a potentially stale snapshot if the server's research
      // telemetry hasn't been merged into /v1/savings yet.
      if (!deepResearch) {
        fetchSavings()
          .then((data) => useAppStore.getState().setSavings(data))
          .catch(() => {});
      }
    }
  }, [
    input,
    activeId,
    selectedModel,
    streamState.isStreaming,
    createConversation,
    addMessage,
    updateLastAssistant,
    setStreamState,
    resetStream,
    deepResearch,
    temperature,
    maxTokens,
    attachments,
    companionMode,
  ]);

  // ── Keyboard handler ─────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Selected project name ─────────────────────────────────────────────
  const selectedProject = DEMO_PROJECTS.find((p) => p.id === selectedProjectId);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div
      className="px-4 pb-4 pt-2"
      style={{ maxWidth: 'var(--chat-max-width)', margin: '0 auto', width: '100%' }}
    >
      {/* ── Mode toggles row (Deep Research / Companion) ── */}
      <div className="mb-3 flex flex-col gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setDeepResearch(!deepResearch)}
            disabled={streamState.isStreaming}
            aria-pressed={deepResearch}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors cursor-pointer disabled:cursor-default disabled:opacity-50"
            style={{
              background: deepResearch ? 'var(--color-accent-subtle)' : 'transparent',
              border: `1px solid ${deepResearch ? 'var(--color-accent)' : 'var(--color-border)'}`,
              color: deepResearch ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
            }}
            title={deepResearch ? 'Deep Research: on' : 'Deep Research: off'}
          >
            <Search size={12} />
            Deep Research
          </button>
          <button
            type="button"
            onClick={() => setCompanionMode(!companionMode)}
            disabled={streamState.isStreaming}
            aria-pressed={companionMode}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors cursor-pointer disabled:cursor-default disabled:opacity-50"
            style={{
              background: companionMode ? 'rgba(244, 63, 94, 0.15)' : 'transparent',
              border: `1px solid ${companionMode ? '#f43f5e' : 'var(--color-border)'}`,
              color: companionMode ? '#f43f5e' : 'var(--color-text-tertiary)',
            }}
            title={companionMode ? 'Companion Mode: On (Heart-to-Heart)' : 'Companion Mode: Off'}
          >
            <Heart size={12} fill={companionMode ? '#f43f5e' : 'none'} />
            Companion Mode
          </button>
        </div>
        {deepResearch && corpusSync.syncing && corpusSync.itemsSynced > 0 && (
          <div
            className="text-[11px] leading-snug"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            Searching over{' '}
            <span key={corpusSync.itemsSynced} className="sync-bump" style={{ color: 'var(--color-text-secondary)' }}>
              {corpusSync.itemsSynced.toLocaleString()}
            </span>{' '}
            items — sync in progress, results will improve as more data is indexed.
          </div>
        )}
      </div>

      {/* ── Main composer card ── */}
      <div
        ref={dropZoneRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="rounded-2xl transition-all"
        style={{
          background: 'var(--color-input-bg)',
          border: isDragging
            ? '2px solid var(--color-accent)'
            : '1.5px solid var(--color-accent-glow)',
          boxShadow: isDragging
            ? '0 0 0 3px var(--color-accent-subtle), var(--shadow-md)'
            : '0 2px 12px 0 rgba(8,145,178,0.10), var(--shadow-sm)',
        }}
      >
        {/* Drag overlay hint */}
        {isDragging && (
          <div
            className="absolute inset-0 rounded-2xl z-10 flex items-center justify-center pointer-events-none"
            style={{ background: 'var(--color-accent-subtle)' }}
          >
            <p className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
              Drop files here
            </p>
          </div>
        )}

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs max-w-[180px]"
                style={{
                  background: att.status === 'error' ? 'rgba(220,38,38,0.08)' : 'var(--color-bg-secondary)',
                  border: `1px solid ${att.status === 'error' ? 'var(--color-error)' : 'var(--color-border)'}`,
                  color: att.status === 'error' ? 'var(--color-error)' : 'var(--color-text-secondary)',
                }}
                title={att.name}
              >
                {att.type.startsWith('image/') ? (
                  <Image size={11} />
                ) : (
                  <File size={11} />
                )}
                <span className="truncate">{att.name}</span>
                {att.status === 'pending' && (
                  <span className="animate-pulse text-[10px]">…</span>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  className="ml-1 rounded cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
                  aria-label={`Remove ${att.name}`}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <div className="px-4 pt-3 pb-1">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              companionMode
                ? 'Talk with Sora, share your feelings or thoughts...'
                : selectedModel
                ? 'Do anything...'
                : 'Pick a model first (⌘K)...'
            }
            rows={1}
            className="w-full bg-transparent outline-none resize-none text-sm leading-relaxed"
            style={{ color: 'var(--color-text)', maxHeight: '200px' }}
            disabled={streamState.isStreaming || modelLoading}
            aria-label="Message input"
          />
        </div>

        {/* ── Bottom toolbar ── */}
        <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
          {/* Plus / Attachment */}
          <div className="relative" data-composer-menu>
            <button
              ref={attachBtnRef}
              type="button"
              onClick={() => {
                setShowAttachMenu((v) => !v);
                setShowEffortMenu(false);
                setShowProjectPicker(false);
                setShowPlugins(false);
              }}
              className="p-1.5 rounded-lg transition-colors cursor-pointer hover:bg-[var(--color-bg-secondary)]"
              style={{ color: 'var(--color-text-tertiary)' }}
              title="Add attachment"
              aria-label="Add attachment"
              aria-expanded={showAttachMenu}
            >
              <Paperclip size={16} />
            </button>
            {showAttachMenu && (
              <AttachmentMenu
                onAdd={addFiles}
                onClose={() => setShowAttachMenu(false)}
              />
            )}
          </div>

          {/* Mode selector (Search / Computer) */}
          <div
            className="flex items-center rounded-full p-0.5"
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border)',
            }}
            role="group"
            aria-label="Chat mode"
          >
            <button
              type="button"
              onClick={() => setChatMode('search')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-all cursor-pointer"
              aria-pressed={chatMode === 'search'}
              style={{
                background: chatMode === 'search' ? 'var(--color-input-bg)' : 'transparent',
                color: chatMode === 'search' ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                fontWeight: chatMode === 'search' ? '600' : undefined,
                boxShadow: chatMode === 'search' ? 'var(--shadow-sm)' : undefined,
              }}
            >
              <Search size={11} />
              Search
            </button>
            <button
              type="button"
              onClick={() => setChatMode('computer')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-all cursor-pointer"
              aria-pressed={chatMode === 'computer'}
              style={{
                background: chatMode === 'computer' ? 'var(--color-input-bg)' : 'transparent',
                color: chatMode === 'computer' ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                fontWeight: chatMode === 'computer' ? '600' : undefined,
                boxShadow: chatMode === 'computer' ? 'var(--shadow-sm)' : undefined,
              }}
            >
              <Monitor size={11} />
              Computer
            </button>
          </div>

          {/* Effort selector */}
          <div className="relative" data-composer-menu>
            <button
              type="button"
              onClick={() => {
                setShowEffortMenu((v) => !v);
                setShowAttachMenu(false);
                setShowProjectPicker(false);
                setShowPlugins(false);
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors cursor-pointer hover:bg-[var(--color-bg-secondary)]"
              style={{
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border)',
              }}
              aria-expanded={showEffortMenu}
              aria-haspopup="listbox"
              title="Select effort level"
            >
              <SlidersHorizontal size={11} />
              <span className="capitalize">{effortLevel}</span>
              <ChevronDown size={11} />
            </button>
            {showEffortMenu && (
              <div
                className="absolute bottom-full left-0 mb-2 rounded-xl shadow-lg border overflow-hidden z-50 min-w-[140px]"
                style={{ background: 'var(--color-input-bg)', borderColor: 'var(--color-border)' }}
                role="listbox"
                aria-label="Effort level"
              >
                <p className="px-3 py-1.5 text-[11px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
                  Effort level
                </p>
                {EFFORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={effortLevel === opt.value}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-[var(--color-bg-secondary)]"
                    style={{
                      color: effortLevel === opt.value ? 'var(--color-accent)' : 'var(--color-text)',
                      fontWeight: effortLevel === opt.value ? '600' : undefined,
                    }}
                    onClick={() => { setEffortLevel(opt.value); setShowEffortMenu(false); }}
                  >
                    {opt.label}
                    {effortLevel === opt.value && <span className="ml-auto text-[10px]">✓</span>}
                  </button>
                ))}
                <p className="px-3 pb-2 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  Effort level is noted in your request.
                </p>
              </div>
            )}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Streaming state: stop button */}
          {isCurrentChatStreaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              className="p-2 rounded-xl transition-colors shrink-0 cursor-pointer"
              style={{ background: 'var(--color-error)', color: 'var(--color-on-accent)' }}
              title="Stop generating"
              aria-label="Stop generating"
            >
              <Square size={15} />
            </button>
          ) : (
            <div className="flex items-center gap-1">
              {/* Mic button */}
              <MicButton
                state={speechState}
                onClick={handleMicClick}
                disabled={micDisabled}
                reason={micReason}
              />

              {/* Voice Mode button */}
              <button
                type="button"
                onClick={() => useAppStore.getState().setVoiceModeOpen(true)}
                className="p-2 rounded-xl transition-all shrink-0 cursor-pointer"
                style={{ color: 'var(--color-text-tertiary)' }}
                title="Open Live Voice Mode"
                aria-label="Open Live Voice Mode"
              >
                <Headphones size={16} />
              </button>

              {/* Send button — shown when text entered, else waveform/mic hint */}
              {input.trim() ? (
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={streamState.isStreaming || !input.trim() || modelLoading || !selectedModel}
                  title={selectedModel ? 'Send message' : 'Pick a model first (⌘K)'}
                  className="p-2 rounded-xl transition-colors shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-default"
                  style={{
                    background: 'var(--color-accent)',
                    color: 'white',
                  }}
                  aria-label="Send message"
                >
                  <Send size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className="w-9 h-9 flex items-center justify-center rounded-full shrink-0 cursor-pointer transition-all"
                  style={{ background: 'var(--color-text)', color: 'var(--color-bg)' }}
                  onClick={handleMicClick}
                  title="Start voice input"
                  aria-label="Start voice input"
                >
                  <Mic size={15} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Project picker + Plugins row ── */}
      <div className="flex items-center gap-4 mt-2.5 px-1">
        {/* Project picker */}
        <div className="relative" data-composer-menu>
          <button
            type="button"
            onClick={() => {
              setShowProjectPicker((v) => !v);
              setShowPlugins(false);
              setShowAttachMenu(false);
              setShowEffortMenu(false);
            }}
            className="flex items-center gap-1.5 text-xs transition-colors cursor-pointer hover:opacity-80"
            style={{ color: selectedProject ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}
            aria-expanded={showProjectPicker}
            aria-haspopup="dialog"
            title="Choose a project"
          >
            <Folder size={13} />
            <span>{selectedProject ? selectedProject.name : 'Choose a project'}</span>
          </button>
          {showProjectPicker && (
            <ProjectPicker
              selectedId={selectedProjectId}
              onSelect={setSelectedProjectId}
              onClose={() => setShowProjectPicker(false)}
            />
          )}
        </div>

        <span style={{ color: 'var(--color-border)', fontSize: '12px' }}>·</span>

        {/* Plugins */}
        <div className="relative" data-composer-menu>
          <button
            type="button"
            onClick={() => {
              setShowPlugins((v) => !v);
              setShowProjectPicker(false);
              setShowAttachMenu(false);
              setShowEffortMenu(false);
            }}
            className="flex items-center gap-1.5 text-xs transition-colors cursor-pointer hover:opacity-80"
            style={{
              color: enabledPluginIds.length > 0 ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
            }}
            aria-expanded={showPlugins}
            aria-haspopup="dialog"
            title="Manage plugins"
          >
            <Plug2 size={13} />
            <span>
              Plugins{enabledPluginIds.length > 0 ? ` (${enabledPluginIds.length})` : ''}
            </span>
          </button>
          {showPlugins && (
            <PluginsPanel
              enabledIds={enabledPluginIds}
              onToggle={togglePlugin}
              onClose={() => setShowPlugins(false)}
            />
          )}
        </div>

        {/* Hint */}
        <div className="flex-1 text-right">
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            <kbd className="font-mono">Enter</kbd> to send &middot;{' '}
            <kbd className="font-mono">Shift+Enter</kbd> for new line
          </span>
        </div>
      </div>

      {/* ── Suggestion chips ── */}
      <div className="flex gap-2 mt-3 overflow-x-auto pb-1 no-scrollbar">
        {SUGGESTION_CHIPS.map((chip) => {
          const Icon = chip.icon;
          return (
            <button
              key={chip.label}
              type="button"
              onClick={() => setInput(chip.prompt)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap transition-all cursor-pointer shrink-0 hover:shadow-sm"
              style={{
                background: 'var(--color-input-bg)',
                border: '1.5px solid var(--color-accent-glow)',
                color: 'var(--color-text-secondary)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-accent)';
                e.currentTarget.style.color = 'var(--color-accent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-accent-glow)';
                e.currentTarget.style.color = 'var(--color-text-secondary)';
              }}
              title={chip.prompt}
            >
              <Icon size={12} />
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
