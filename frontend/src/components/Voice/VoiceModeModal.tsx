import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Sparkles,
  Heart,
  MessageSquare,
  Headphones,
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
import { transcribeAudio } from '../../lib/api';

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export function VoiceModeModal() {
  const voiceModeOpen = useAppStore((s) => s.voiceModeOpen);
  const setVoiceModeOpen = useAppStore((s) => s.setVoiceModeOpen);
  const settings = useAppStore((s) => s.settings);
  const setVoiceGender = useAppStore((s) => s.setVoiceGender);
  const activeId = useAppStore((s) => s.activeId);
  const createConversation = useAppStore((s) => s.createConversation);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const addMessage = useAppStore((s) => s.addMessage);

  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [userTranscript, setUserTranscript] = useState('');
  const [assistantTranscript, setAssistantTranscript] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const currentGender = settings.voiceGender || 'female';

  // Cleanup speech synthesis and timers
  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    currentUtteranceRef.current = null;
    if (voiceState === 'speaking') {
      setVoiceState('idle');
    }
  }, [voiceState]);

  // Speak a text response in the chosen voice gender
  const speakResponse = useCallback(
    (text: string, onDone?: () => void) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        onDone?.();
        return;
      }

      window.speechSynthesis.cancel();

      // Clean text of markdown, asterisks, citations for audio speaking
      const speakableText = text
        .replace(/[*_#`~>\[\]\(\)]/g, ' ')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!speakableText) {
        onDone?.();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(speakableText);
      currentUtteranceRef.current = utterance;

      try {
        const voices = window.speechSynthesis.getVoices();
        const bestVoice = getBestVoice(voices, currentGender);
        configureUtteranceForGender(utterance, currentGender, bestVoice);
      } catch {}

      utterance.onstart = () => {
        setVoiceState('speaking');
      };

      utterance.onend = () => {
        setVoiceState('idle');
        currentUtteranceRef.current = null;
        onDone?.();
      };

      utterance.onerror = () => {
        setVoiceState('idle');
        currentUtteranceRef.current = null;
        onDone?.();
      };

      window.speechSynthesis.speak(utterance);
    },
    [currentGender]
  );

  // Send the transcribed speech to Sora and stream the spoken response
  const processUserMessage = useCallback(
    async (textToSend: string) => {
      const trimmed = textToSend.trim();
      if (!trimmed) {
        setVoiceState('listening');
        return;
      }

      setVoiceState('thinking');
      setUserTranscript(trimmed);
      setAssistantTranscript('');

      let convId = activeId;
      if (!convId) {
        convId = createConversation(selectedModel);
      }

      // Add user message to active conversation
      const userMsg = {
        id: generateId(),
        role: 'user' as const,
        content: trimmed,
        timestamp: Date.now(),
      };
      addMessage(convId, userMsg);

      // System companion prompt for emotional intelligence & warm conversation
      const systemPrompt = {
        role: 'system' as const,
        content:
          'You are Sora in Live Voice Mode. You are talking directly with the user. Listen with genuine empathy, validate their feelings and experiences, and reply conversationally and warmly like a close friend. Keep your responses natural, engaging, and relatively concise (1 to 3 sentences) so the conversation flows naturally.',
      };

      const currentMsgs = useAppStore.getState().messages;
      const apiMessages = [
        systemPrompt,
        ...currentMsgs.map((m) => ({ role: m.role, content: m.content })),
      ];

      const controller = new AbortController();
      abortControllerRef.current = controller;
      let accumulated = '';

      try {
        for await (const sse of streamChat(
          {
            model: selectedModel || 'qwen2.5:1.5b',
            messages: apiMessages,
            stream: true,
            temperature: 0.85,
            max_tokens: 512,
          },
          controller.signal
        )) {
          if (!sse.data) continue;
          try {
            const data = JSON.parse(sse.data);
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              accumulated += delta;
              setAssistantTranscript(accumulated);
            }
          } catch {}
        }

        // Add assistant message to conversation
        if (accumulated.trim()) {
          const assistantMsg = {
            id: generateId(),
            role: 'assistant' as const,
            content: accumulated,
            timestamp: Date.now(),
          };
          addMessage(convId, assistantMsg);

          // Speak reply aloud!
          speakResponse(accumulated, () => {
            // Once spoken, automatically resume listening after a brief pause
            if (voiceModeOpen && !isMuted) {
              setTimeout(() => {
                startListening();
              }, 400);
            }
          });
        } else {
          setVoiceState('idle');
        }
      } catch (err) {
        setVoiceState('idle');
      }
    },
    [activeId, createConversation, selectedModel, addMessage, speakResponse, voiceModeOpen, isMuted]
  );

  // Start listening to the microphone
  const startListening = useCallback(async () => {
    if (isMuted) return;
    stopSpeaking();
    setUserTranscript('');
    setVoiceState('listening');

    // 1. Setup Web Speech Recognition if available (instant live transcription)
    if (
      typeof window !== 'undefined' &&
      ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
    ) {
      try {
        if (recognitionRef.current) {
          recognitionRef.current.abort();
        }
        const SpeechRec =
          (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new SpeechRec();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';

        rec.onresult = (e: any) => {
          let interim = '';
          for (let i = 0; i < e.results.length; i++) {
            interim += e.results[i][0].transcript;
          }
          setUserTranscript(interim);

          // Auto-turn: reset silence timer when user is speaking
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = setTimeout(() => {
            if (interim.trim()) {
              rec.stop();
              processUserMessage(interim);
            }
          }, 1500); // 1.5s pause signals end of turn
        };

        rec.onerror = () => {
          // If error or silence, stay ready
        };

        rec.start();
        recognitionRef.current = rec;
      } catch {}
    }

    // 2. Setup Audio Waveform Visualizer
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = audioCtx;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyserRef.current = analyser;

        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const checkLevel = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const avg = sum / dataArray.length;
          setAudioLevel(Math.min(1, avg / 128));
          animFrameRef.current = requestAnimationFrame(checkLevel);
        };
        checkLevel();
      } catch {}
    }
  }, [isMuted, stopSpeaking, processUserMessage]);

  // Stop listening
  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }
  }, []);

  // When modal opens/closes
  useEffect(() => {
    if (voiceModeOpen) {
      startListening();
    } else {
      stopListening();
      stopSpeaking();
    }

    return () => {
      stopListening();
      stopSpeaking();
    };
  }, [voiceModeOpen]);

  // When gender changes during active session, give immediate voice preview
  const handleGenderChange = (gender: VoiceGender) => {
    setVoiceGender(gender);
    stopSpeaking();
    const previewText =
      gender === 'female'
        ? 'Hi there! I am Sora. You can share whatever is on your mind.'
        : 'Hello. I am Sora. I am here to listen and help.';
    speakResponse(previewText);
  };

  if (!voiceModeOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-between items-center p-6 sm:p-10 bg-gradient-to-b from-zinc-950 via-zinc-900 to-black text-white select-none backdrop-blur-2xl transition-all duration-300">
      {/* ── Top Bar ── */}
      <div className="w-full max-w-4xl flex items-center justify-between z-10">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-md border border-white/15 text-xs font-medium">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              voiceState === 'listening'
                ? 'bg-emerald-400 animate-ping'
                : voiceState === 'speaking'
                ? 'bg-rose-400 animate-pulse'
                : voiceState === 'thinking'
                ? 'bg-amber-400 animate-pulse'
                : 'bg-zinc-400'
            }`}
          />
          <span className="capitalize tracking-wide">
            {voiceState === 'listening'
              ? 'Listening...'
              : voiceState === 'thinking'
              ? 'Thinking...'
              : voiceState === 'speaking'
              ? 'Speaking...'
              : 'Voice Ready'}
          </span>
        </div>

        {/* ── Voice Gender Switcher ── */}
        <div className="flex items-center bg-zinc-800/80 p-1 rounded-full border border-white/10 shadow-lg">
          {SORA_VOICE_OPTIONS.map((opt) => {
            const isSelected = currentGender === opt.gender;
            return (
              <button
                key={opt.gender}
                onClick={() => handleGenderChange(opt.gender)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-rose-500 text-white shadow-md shadow-rose-500/30'
                    : 'text-zinc-400 hover:text-white'
                }`}
                title={`Switch to ${opt.name}`}
              >
                <span>{opt.avatar}</span>
                <span>{opt.gender === 'female' ? 'Female' : 'Male'}</span>
                {isSelected && <Check size={12} />}
              </button>
            );
          })}
        </div>

        {/* ── Close Button ── */}
        <button
          onClick={() => {
            stopListening();
            stopSpeaking();
            setVoiceModeOpen(false);
          }}
          className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-zinc-300 hover:text-white cursor-pointer"
          title="Switch to Chat Mode"
        >
          <X size={20} />
        </button>
      </div>

      {/* ── Center: Interactive Animated Orb & Transcript ── */}
      <div className="flex-1 flex flex-col items-center justify-center w-full max-w-2xl text-center px-4 z-10">
        {/* Animated Voice Orb (Copilot / ChatGPT style) */}
        <div
          onClick={() => {
            if (voiceState === 'speaking') {
              stopSpeaking();
              startListening();
            } else if (voiceState === 'listening') {
              stopListening();
              setVoiceState('idle');
            } else {
              startListening();
            }
          }}
          className="relative w-56 h-56 sm:w-64 sm:h-64 rounded-full flex items-center justify-center cursor-pointer transition-transform hover:scale-105 active:scale-95"
        >
          {/* Outer glowing pulsing aura */}
          <div
            className={`absolute inset-0 rounded-full blur-3xl opacity-60 transition-all duration-700 ${
              voiceState === 'listening'
                ? 'bg-gradient-to-tr from-emerald-500 via-teal-400 to-cyan-500 scale-125'
                : voiceState === 'thinking'
                ? 'bg-gradient-to-tr from-amber-500 via-orange-500 to-purple-600 animate-spin scale-110'
                : voiceState === 'speaking'
                ? 'bg-gradient-to-tr from-rose-500 via-pink-500 to-indigo-500 scale-125'
                : 'bg-zinc-700 scale-95'
            }`}
            style={{
              transform:
                voiceState === 'listening'
                  ? `scale(${1.1 + audioLevel * 0.4})`
                  : undefined,
            }}
          />

          {/* Core sphere with fluid gradient */}
          <div
            className={`w-44 h-44 sm:w-52 sm:h-52 rounded-full relative z-10 flex items-center justify-center shadow-2xl transition-all duration-500 ${
              voiceState === 'listening'
                ? 'bg-gradient-to-br from-emerald-400 to-cyan-700 shadow-emerald-500/50'
                : voiceState === 'thinking'
                ? 'bg-gradient-to-br from-amber-400 to-purple-800 shadow-purple-500/50'
                : voiceState === 'speaking'
                ? 'bg-gradient-to-br from-rose-400 to-indigo-700 shadow-rose-500/50'
                : 'bg-zinc-800 shadow-black'
            }`}
            style={{
              transform:
                voiceState === 'listening'
                  ? `scale(${1 + audioLevel * 0.2})`
                  : voiceState === 'speaking'
                  ? 'scale(1.05)'
                  : 'scale(1)',
            }}
          >
            {/* Center icon */}
            <div className="text-white drop-shadow-md">
              {voiceState === 'speaking' ? (
                <Volume2 size={44} className="animate-pulse" />
              ) : voiceState === 'thinking' ? (
                <Sparkles size={44} className="animate-spin" />
              ) : isMuted ? (
                <MicOff size={44} className="text-zinc-400" />
              ) : (
                <Mic size={44} className="animate-pulse" />
              )}
            </div>
          </div>
        </div>

        {/* Dynamic Live Subtitles / Text Feedback */}
        <div className="mt-8 min-h-[5rem] flex flex-col items-center justify-center">
          {voiceState === 'listening' && (
            <p className="text-lg sm:text-xl font-medium text-emerald-300 transition-opacity">
              {userTranscript || 'Listening... talk freely about how you feel'}
            </p>
          )}

          {voiceState === 'thinking' && (
            <p className="text-lg sm:text-xl font-medium text-amber-300 animate-pulse">
              Sora is reflecting on what you said...
            </p>
          )}

          {voiceState === 'speaking' && (
            <p className="text-base sm:text-lg text-zinc-200 line-clamp-3 leading-relaxed px-4">
              "{assistantTranscript}"
            </p>
          )}

          {voiceState === 'idle' && (
            <p className="text-sm sm:text-base text-zinc-400">
              Tap the orb or speak to start sharing with Sora
            </p>
          )}
        </div>
      </div>

      {/* ── Bottom Controls ── */}
      <div className="w-full max-w-md flex items-center justify-center gap-4 z-10 pb-4">
        {/* Mute / Unmute */}
        <button
          onClick={() => {
            if (isMuted) {
              setIsMuted(false);
              startListening();
            } else {
              setIsMuted(true);
              stopListening();
              setVoiceState('idle');
            }
          }}
          className={`p-4 rounded-full transition-all cursor-pointer shadow-lg ${
            isMuted
              ? 'bg-red-500/20 text-red-400 border border-red-500/40'
              : 'bg-white/10 hover:bg-white/20 text-white border border-white/10'
          }`}
          title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>

        {/* Interrupt / Stop Speaking */}
        {voiceState === 'speaking' && (
          <button
            onClick={() => {
              stopSpeaking();
              startListening();
            }}
            className="px-5 py-3 rounded-full bg-rose-500 hover:bg-rose-600 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-rose-500/30 transition-transform active:scale-95 cursor-pointer"
            title="Interrupt and speak now"
          >
            <VolumeX size={18} />
            <span>Interrupt</span>
          </button>
        )}

        {/* Switch to Chat mode */}
        <button
          onClick={() => {
            stopListening();
            stopSpeaking();
            setVoiceModeOpen(false);
          }}
          className="px-5 py-3 rounded-full bg-white/10 hover:bg-white/20 text-zinc-200 hover:text-white font-medium text-sm flex items-center gap-2 border border-white/10 shadow-lg transition-all cursor-pointer"
          title="Return to text chat view"
        >
          <MessageSquare size={18} />
          <span>Switch to Chat</span>
        </button>
      </div>
    </div>
  );
}
