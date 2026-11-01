/**
 * VoiceModeModal — full-screen live voice conversation with Sora.
 *
 * Key fixes over the previous version:
 *  - Uses a ref-based state machine so callbacks never close over stale
 *    React state (the root cause of "no input / no output").
 *  - Properly awaits SpeechSynthesis voice list before speaking
 *    (voiceschanged is async — the old version always got an empty list).
 *  - Web Speech API continuous recognition drives the turn — no MediaRecorder
 *    upload latency in the recognition path.
 *  - Silence detection restarted correctly after each AI response.
 *  - Conversation history passed to every AI turn for contextual replies.
 *  - max_tokens reduced to 150 for sub-second first-token latency at 1.5b.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Sparkles,
  MessageSquare,
  Check,
} from 'lucide-react';
import { useAppStore, generateId } from '../../lib/store';
import { streamChat } from '../../lib/sse';
import {
  VoiceGender,
  SORA_VOICE_OPTIONS,
  getBestVoice,
  configureUtteranceForGender,
} from '../../lib/voice-profiles';

// ── Types ────────────────────────────────────────────────────────────────────

type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasBrowserSpeech(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  );
}

function getSpeechRecognitionClass(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

/** Returns voices, waiting up to 1 s for the browser to load them. */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const v = window.speechSynthesis.getVoices();
    if (v.length > 0) { resolve(v); return; }
    const handler = () => {
      resolve(window.speechSynthesis.getVoices());
      window.speechSynthesis.removeEventListener('voiceschanged', handler);
    };
    window.speechSynthesis.addEventListener('voiceschanged', handler);
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1000);
  });
}

/** Strip markdown formatting so it sounds natural when spoken. */
function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/`[^`]+`/g, '')
    .replace(/[*_#~>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Component ────────────────────────────────────────────────────────────────

export function VoiceModeModal() {
  const voiceModeOpen = useAppStore((s) => s.voiceModeOpen);
  const setVoiceModeOpen = useAppStore((s) => s.setVoiceModeOpen);
  const settings = useAppStore((s) => s.settings);
  const setVoiceGender = useAppStore((s) => s.setVoiceGender);
  const activeId = useAppStore((s) => s.activeId);
  const createConversation = useAppStore((s) => s.createConversation);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const addMessage = useAppStore((s) => s.addMessage);

  // ── UI state (render only) ───────────────────────────────────────────
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [aiReply, setAiReply] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [noSpeechAPI, setNoSpeechAPI] = useState(false);

  // ── Ref-based state (no stale closure issues) ────────────────────────
  const phaseRef = useRef<VoicePhase>('idle');
  const isMutedRef = useRef(false);
  const openRef = useRef(false);
  const genderRef = useRef<VoiceGender>(settings.voiceGender || 'female');
  const modelRef = useRef(selectedModel || 'qwen2.5:1.5b');
  const activeIdRef = useRef(activeId);
  const convIdRef = useRef<string | null>(null);

  // Keep refs in sync with props/state
  useEffect(() => { genderRef.current = settings.voiceGender || 'female'; }, [settings.voiceGender]);
  useEffect(() => { modelRef.current = selectedModel || 'qwen2.5:1.5b'; }, [selectedModel]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { openRef.current = voiceModeOpen; }, [voiceModeOpen]);

  // ── Audio / recognition refs ─────────────────────────────────────────
  const recRef = useRef<any>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const liveTextRef = useRef('');

  // ── setPhase wrapper that updates ref too ────────────────────────────
  const updatePhase = useCallback((p: VoicePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // ── Stop speech synthesis ────────────────────────────────────────────
  const stopSpeaking = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    utteranceRef.current = null;
  }, []);

  // ── Speak a reply aloud, then call onDone ────────────────────────────
  const speakReply = useCallback(async (text: string, onDone: () => void) => {
    stopSpeaking();
    const speakable = toSpeakable(text);
    if (!speakable || !('speechSynthesis' in window)) { onDone(); return; }

    const utterance = new SpeechSynthesisUtterance(speakable);
    utteranceRef.current = utterance;

    try {
      const voices = await loadVoices();
      const gender = genderRef.current;
      const best = getBestVoice(voices, gender);
      configureUtteranceForGender(utterance, gender, best);
    } catch {}

    utterance.onstart = () => updatePhase('speaking');
    utterance.onend = () => {
      utteranceRef.current = null;
      onDone();
    };
    utterance.onerror = () => {
      utteranceRef.current = null;
      onDone();
    };

    // Chrome bug: speech synthesis pauses when tab is background.
    // Resume every 10 s to keep it going.
    const keepAliveId = setInterval(() => {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    }, 10000);
    utterance.onend = () => {
      clearInterval(keepAliveId);
      utteranceRef.current = null;
      onDone();
    };
    utterance.onerror = () => {
      clearInterval(keepAliveId);
      utteranceRef.current = null;
      onDone();
    };

    updatePhase('speaking');
    window.speechSynthesis.speak(utterance);
  }, [stopSpeaking, updatePhase]);

  // ── Process one user turn through the AI ────────────────────────────
  const processUserTurn = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Nothing heard — go back to listening
      startListening(); // eslint-disable-line
      return;
    }

    updatePhase('thinking');
    setLiveTranscript(trimmed);
    setAiReply('');

    // Ensure we have a conversation
    let convId = convIdRef.current;
    if (!convId) {
      const aid = activeIdRef.current;
      convId = aid || createConversation(modelRef.current);
      convIdRef.current = convId;
    }

    // Add user message to store
    addMessage(convId, {
      id: generateId(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    });

    // Build messages with history for context
    const currentMsgs = useAppStore.getState().messages;
    const apiMessages = [
      {
        role: 'system' as const,
        content:
          'You are Sora in Live Voice Mode. You are having a natural, flowing conversation with the user. Respond warmly and conversationally — like a thoughtful, empathetic friend. Keep responses concise (1-3 sentences) so the conversation feels natural and real-time. Always respond to what was actually said.',
      },
      ...currentMsgs.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    ];

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let accumulated = '';

    try {
      for await (const sse of streamChat(
        {
          model: modelRef.current,
          messages: apiMessages,
          stream: true,
          temperature: 0.75,
          max_tokens: 150, // short for fast voice responses
        },
        controller.signal,
      )) {
        if (!sse.data) continue;
        try {
          const data = JSON.parse(sse.data);
          const delta = data.choices?.[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            setAiReply(accumulated);
          }
        } catch {}
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        updatePhase('idle');
        return;
      }
    }

    if (accumulated.trim()) {
      // Save assistant message
      addMessage(convId, {
        id: generateId(),
        role: 'assistant',
        content: accumulated,
        timestamp: Date.now(),
      });

      // Speak it, then resume listening
      await speakReply(accumulated, () => {
        if (openRef.current && !isMutedRef.current) {
          setTimeout(() => startListening(), 300); // eslint-disable-line
        } else {
          updatePhase('idle');
        }
      });
    } else {
      updatePhase('idle');
    }
  }, [addMessage, createConversation, speakReply, updatePhase]);

  // ── Start microphone + audio analyser + speech recognition ──────────
  const startListening = useCallback(async () => {
    if (isMutedRef.current || !openRef.current) return;
    stopSpeaking();

    updatePhase('listening');
    setLiveTranscript('');
    setAiReply('');
    liveTextRef.current = '';

    // Clear any stale silence timer
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    // ── Speech Recognition ──────────────────────────────────────────
    if (!hasBrowserSpeech()) {
      setNoSpeechAPI(true);
      updatePhase('idle');
      return;
    }

    const SpeechRec = getSpeechRecognitionClass();
    if (!SpeechRec) { setNoSpeechAPI(true); updatePhase('idle'); return; }

    try {
      // Stop any existing recognition
      if (recRef.current) {
        try { recRef.current.abort(); } catch {}
        recRef.current = null;
      }

      const rec = new SpeechRec();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      rec.maxAlternatives = 1;

      rec.onresult = (e: any) => {
        if (phaseRef.current !== 'listening') return;

        let finalText = '';
        let interimText = '';
        for (let i = 0; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t;
          else interimText += t;
        }
        const best = (finalText || interimText).trim();
        liveTextRef.current = best;
        setLiveTranscript(best);

        // Silence detection: send after 1.8 s of no new words
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        if (best) {
          silenceTimerRef.current = setTimeout(() => {
            if (phaseRef.current !== 'listening') return;
            const captured = liveTextRef.current.trim();
            if (!captured) return;
            try { rec.abort(); } catch {}
            recRef.current = null;
            processUserTurn(captured);
          }, 1800);
        }
      };

      rec.onerror = (e: any) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          setPermissionDenied(true);
          updatePhase('idle');
          return;
        }
        // no-speech / network errors: restart
        if (openRef.current && !isMutedRef.current && phaseRef.current === 'listening') {
          setTimeout(() => startListening(), 500);
        }
      };

      rec.onend = () => {
        recRef.current = null;
        // If we're still supposed to be listening (e.g., no-speech timeout),
        // restart recognition automatically.
        if (openRef.current && !isMutedRef.current && phaseRef.current === 'listening') {
          setTimeout(() => startListening(), 200);
        }
      };

      rec.start();
      recRef.current = rec;
    } catch {
      updatePhase('idle');
      return;
    }

    // ── Audio level visualizer ──────────────────────────────────────
    if (!streamRef.current && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyserRef.current = analyser;

        const src = ctx.createMediaStreamSource(stream);
        src.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          setAudioLevel(Math.min(1, avg / 80));
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // Mic access denied for visualizer — recognition still works via browser API
      }
    }
  }, [stopSpeaking, updatePhase, processUserTurn]);

  // ── Stop listening ───────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recRef.current) {
      try { recRef.current.abort(); } catch {}
      recRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
  }, []);

  // ── Full teardown ────────────────────────────────────────────────────
  const teardownAll = useCallback(() => {
    stopListening();
    stopSpeaking();
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    updatePhase('idle');
    setLiveTranscript('');
    setAiReply('');
    liveTextRef.current = '';
  }, [stopListening, stopSpeaking, updatePhase]);

  // ── Open / close effect ──────────────────────────────────────────────
  useEffect(() => {
    if (voiceModeOpen) {
      setPermissionDenied(false);
      setNoSpeechAPI(false);
      // Small delay lets the modal animation settle before requesting mic
      setTimeout(() => startListening(), 400);
    } else {
      teardownAll();
    }
    return () => teardownAll();
  }, [voiceModeOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mute toggle ──────────────────────────────────────────────────────
  const handleMuteToggle = useCallback(() => {
    const willMute = !isMutedRef.current;
    setIsMuted(willMute);
    isMutedRef.current = willMute;
    if (willMute) {
      stopListening();
      updatePhase('idle');
    } else {
      setTimeout(() => startListening(), 100);
    }
  }, [stopListening, startListening, updatePhase]);

  // ── Orb click: toggle listen/pause ──────────────────────────────────
  const handleOrbClick = useCallback(() => {
    if (phaseRef.current === 'speaking') {
      stopSpeaking();
      startListening();
    } else if (phaseRef.current === 'listening') {
      stopListening();
      updatePhase('idle');
    } else if (phaseRef.current === 'idle') {
      startListening();
    }
  }, [stopSpeaking, stopListening, startListening, updatePhase]);

  // ── Gender switch with preview ───────────────────────────────────────
  const handleGenderChange = useCallback((gender: VoiceGender) => {
    setVoiceGender(gender);
    genderRef.current = gender;
    stopSpeaking();
    const preview =
      gender === 'female'
        ? "Hi! I'm Sora. What's on your mind?"
        : "Hello. I'm Sora. How can I help you?";
    speakReply(preview, () => {
      if (openRef.current && !isMutedRef.current) startListening();
    });
  }, [setVoiceGender, stopSpeaking, speakReply, startListening]);

  if (!voiceModeOpen) return null;

  // ── Phase-specific colors ────────────────────────────────────────────
  const orbGlow =
    phase === 'listening'
      ? 'from-emerald-500 via-teal-400 to-cyan-500'
      : phase === 'thinking'
      ? 'from-amber-500 via-orange-400 to-purple-600'
      : phase === 'speaking'
      ? 'from-rose-500 via-pink-400 to-indigo-500'
      : 'opacity-0';

  const orbCore =
    phase === 'listening'
      ? 'from-emerald-400 to-cyan-700 shadow-emerald-500/50'
      : phase === 'thinking'
      ? 'from-amber-400 to-purple-800 shadow-purple-500/50'
      : phase === 'speaking'
      ? 'from-rose-400 to-indigo-700 shadow-rose-500/50'
      : 'bg-zinc-800 shadow-black';

  const statusLabel =
    phase === 'listening' ? 'Listening…'
    : phase === 'thinking' ? 'Thinking…'
    : phase === 'speaking' ? 'Speaking…'
    : 'Voice Ready';

  const statusDot =
    phase === 'listening' ? 'bg-emerald-400 animate-ping'
    : phase === 'thinking' ? 'bg-amber-400 animate-pulse'
    : phase === 'speaking' ? 'bg-rose-400 animate-pulse'
    : 'bg-zinc-500';

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-between items-center p-6 sm:p-10 bg-gradient-to-b from-zinc-950 via-zinc-900 to-black text-white select-none backdrop-blur-2xl">
      {/* ── Top Bar ── */}
      <div className="w-full max-w-4xl flex items-center justify-between z-10">
        {/* Status pill */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-md border border-white/15 text-xs font-medium">
          <div className={`w-2.5 h-2.5 rounded-full ${statusDot}`} />
          <span className="tracking-wide">{statusLabel}</span>
        </div>

        {/* Gender switcher */}
        <div className="flex items-center bg-zinc-800/80 p-1 rounded-full border border-white/10 shadow-lg">
          {SORA_VOICE_OPTIONS.map((opt) => {
            const sel = (settings.voiceGender || 'female') === opt.gender;
            return (
              <button
                key={opt.gender}
                onClick={() => handleGenderChange(opt.gender)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer ${
                  sel
                    ? 'bg-rose-500 text-white shadow-md shadow-rose-500/30'
                    : 'text-zinc-400 hover:text-white'
                }`}
                title={`Switch to ${opt.name}`}
              >
                <span>{opt.avatar}</span>
                <span>{opt.gender === 'female' ? 'Female' : 'Male'}</span>
                {sel && <Check size={12} />}
              </button>
            );
          })}
        </div>

        {/* Close */}
        <button
          onClick={() => setVoiceModeOpen(false)}
          className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-zinc-300 hover:text-white cursor-pointer"
          title="Close Voice Mode"
          aria-label="Close Voice Mode"
        >
          <X size={20} />
        </button>
      </div>

      {/* ── Center: Orb + Transcripts ── */}
      <div className="flex-1 flex flex-col items-center justify-center w-full max-w-2xl text-center px-4 z-10">

        {/* Error states */}
        {permissionDenied && (
          <div className="mb-6 px-5 py-3 rounded-xl bg-red-500/20 border border-red-500/40 text-red-300 text-sm">
            Microphone permission denied. Please allow mic access in your browser settings and refresh.
          </div>
        )}
        {noSpeechAPI && (
          <div className="mb-6 px-5 py-3 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-200 text-sm">
            Voice input requires Chrome or Edge. Please open Sora in Chrome for the best experience.
          </div>
        )}

        {/* Animated orb */}
        <div
          onClick={handleOrbClick}
          className="relative w-56 h-56 sm:w-64 sm:h-64 rounded-full flex items-center justify-center cursor-pointer transition-transform hover:scale-105 active:scale-95"
          title={phase === 'listening' ? 'Tap to pause' : 'Tap to start listening'}
        >
          {/* Glow aura */}
          <div
            className={`absolute inset-0 rounded-full blur-3xl opacity-60 transition-all duration-700 bg-gradient-to-tr ${orbGlow}`}
            style={{
              transform:
                phase === 'listening'
                  ? `scale(${1.15 + audioLevel * 0.35})`
                  : phase === 'speaking'
                  ? 'scale(1.2)'
                  : 'scale(0.9)',
            }}
          />

          {/* Core sphere */}
          <div
            className={`w-44 h-44 sm:w-52 sm:h-52 rounded-full relative z-10 flex items-center justify-center shadow-2xl transition-all duration-500 bg-gradient-to-br ${orbCore}`}
            style={{
              transform:
                phase === 'listening'
                  ? `scale(${1 + audioLevel * 0.18})`
                  : phase === 'speaking'
                  ? 'scale(1.05)'
                  : 'scale(1)',
            }}
          >
            <div className="text-white drop-shadow-md">
              {phase === 'speaking' ? (
                <Volume2 size={44} className="animate-pulse" />
              ) : phase === 'thinking' ? (
                <Sparkles size={44} className="animate-spin" />
              ) : isMuted ? (
                <MicOff size={44} className="text-zinc-400" />
              ) : (
                <Mic size={44} className={phase === 'listening' ? 'animate-pulse' : ''} />
              )}
            </div>
          </div>
        </div>

        {/* Live transcripts */}
        <div className="mt-8 min-h-[5rem] flex flex-col items-center justify-center gap-2 max-w-lg">
          {phase === 'listening' && (
            <p className="text-lg sm:text-xl font-medium text-emerald-300 transition-all">
              {liveTranscript || 'Listening… speak freely'}
            </p>
          )}
          {phase === 'thinking' && (
            <>
              {liveTranscript && (
                <p className="text-sm text-zinc-400 italic">"{liveTranscript}"</p>
              )}
              <p className="text-lg sm:text-xl font-medium text-amber-300 animate-pulse">
                Sora is thinking…
              </p>
            </>
          )}
          {phase === 'speaking' && (
            <>
              {liveTranscript && (
                <p className="text-sm text-zinc-500 italic">"{liveTranscript}"</p>
              )}
              <p className="text-base sm:text-lg text-zinc-200 leading-relaxed line-clamp-4">
                {aiReply}
              </p>
            </>
          )}
          {phase === 'idle' && !permissionDenied && !noSpeechAPI && (
            <p className="text-sm sm:text-base text-zinc-400">
              Tap the orb or say something to start
            </p>
          )}
        </div>
      </div>

      {/* ── Bottom Controls ── */}
      <div className="w-full max-w-md flex items-center justify-center gap-4 z-10 pb-4">
        {/* Mute */}
        <button
          onClick={handleMuteToggle}
          className={`p-4 rounded-full transition-all cursor-pointer shadow-lg ${
            isMuted
              ? 'bg-red-500/20 text-red-400 border border-red-500/40'
              : 'bg-white/10 hover:bg-white/20 text-white border border-white/10'
          }`}
          title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>

        {/* Interrupt (visible while AI is speaking) */}
        {phase === 'speaking' && (
          <button
            onClick={() => { stopSpeaking(); startListening(); }}
            className="px-5 py-3 rounded-full bg-rose-500 hover:bg-rose-600 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-rose-500/30 transition-transform active:scale-95 cursor-pointer"
            title="Interrupt and speak now"
          >
            <VolumeX size={18} />
            <span>Interrupt</span>
          </button>
        )}

        {/* Switch to Chat */}
        <button
          onClick={() => setVoiceModeOpen(false)}
          className="px-5 py-3 rounded-full bg-white/10 hover:bg-white/20 text-zinc-200 hover:text-white font-medium text-sm flex items-center gap-2 border border-white/10 shadow-lg transition-all cursor-pointer"
          title="Return to text chat"
        >
          <MessageSquare size={18} />
          <span>Switch to Chat</span>
        </button>
      </div>
    </div>
  );
}
