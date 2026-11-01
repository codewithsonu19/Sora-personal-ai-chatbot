import { create } from 'zustand';
import { synthesizeSpeech, fetchTtsHealth } from './api';
import { toSpeakableText } from './message-text';
import { getBestVoice, configureUtteranceForGender, VoiceGender } from './voice-profiles';
import { useAppStore } from './store';

export type TtsState = 'idle' | 'loading' | 'speaking';

/**
 * Voice output is a single shared resource: one utterance at a time, for the
 * whole app. The state lives in one store rather than per component, because a
 * per-component hook would give every message its own audio element -- two
 * replies would then talk over each other, and autoplay would make that the
 * normal case rather than the exception.
 */
interface TtsStore {
  state: TtsState;
  /** id of the message currently loading or speaking, if any. */
  speakingId: string | null;
  error: string | null;
  /** Message whose read-aloud attempt failed, if any. */
  errorId: string | null;
  /** null until the health probe has answered. */
  available: boolean | null;
  /** Last message spoken by autoplay, so a re-render never repeats it. */
  autoSpokenId: string | null;
  speak: (id: string, text: string) => Promise<void>;
  stop: () => void;
  ensureHealth: () => Promise<void>;
  markAutoSpoken: (id: string) => void;
}

// Playback handles are not render state -- keeping them out of the store avoids
// re-rendering every subscriber when an audio element is swapped.
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let controller: AbortController | null = null;
let token = 0;
let healthProbe: Promise<void> | null = null;

/** Only a stream ending in the active conversation may trigger autoplay. */
export function shouldAutoplayFinishedReply(
  previousStreamingConversationId: string | null,
  activeId: string | null,
  streamIsActive: boolean,
  lastMessage: { id: string; role: string } | undefined,
  autoSpokenId: string | null,
): boolean {
  return previousStreamingConversationId !== null
    && previousStreamingConversationId === activeId
    && !streamIsActive
    && lastMessage !== undefined
    && lastMessage.role === 'assistant'
    && lastMessage.id !== autoSpokenId;
}

function teardown(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  if (audio) {
    // Detach first: clearing src re-runs the media load algorithm, which fails
    // on an empty source and dispatches an `error` event. With the handler
    // still attached that surfaces as a bogus "Playback failed" after every
    // successful utterance.
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.src = '';
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (controller) {
    controller.abort();
    controller = null;
  }
}

export const useTtsStore = create<TtsStore>((set, get) => ({
  state: 'idle',
  speakingId: null,
  error: null,
  errorId: null,
  available: null,
  autoSpokenId: null,

  ensureHealth: () => {
    if (healthProbe) return healthProbe;
    healthProbe = fetchTtsHealth()
      .then((health) => {
        if (health.available) {
          set({ available: true });
        } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          set({ available: true });
        } else {
          set({ available: false });
          healthProbe = null;
        }
      })
      .catch(() => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          set({ available: true });
        } else {
          set({ available: false });
          healthProbe = null;
        }
      });
    return healthProbe;
  },

  markAutoSpoken: (id: string) => set({ autoSpokenId: id }),

  speak: async (id: string, text: string) => {
    const trimmed = toSpeakableText(text);
    if (!trimmed) return;

    // Bump before teardown so a synthesis still in flight is both aborted and
    // fenced off by the token, even if the abort loses the race.
    token += 1;
    const mine = token;
    teardown();
    set({ state: 'loading', speakingId: id, error: null, errorId: null });

    const ac = new AbortController();
    controller = ac;

    // Attempt backend speech synthesis first
    let blob: Blob | null = null;
    try {
      blob = await synthesizeSpeech(trimmed, { signal: ac.signal });
    } catch {
      // Backend TTS not configured or errored; will fallback to browser SpeechSynthesis
    }

    if (blob) {
      if (mine !== token) return;
      const url = URL.createObjectURL(blob);
      objectUrl = url;
      const el = new Audio(url);
      audio = el;

      el.onended = () => {
        if (mine !== token) return;
        teardown();
        set({ state: 'idle', speakingId: null });
      };
      el.onerror = () => {
        if (mine !== token) return;
        teardown();
        set({ state: 'idle', speakingId: null, error: 'Playback failed', errorId: id });
      };

      try {
        await el.play();
        if (mine === token) set({ state: 'speaking', speakingId: id });
        return;
      } catch (err) {
        if (mine !== token) return;
        // Audio play failed, fallback to browser speech below
      }
    }

    // High quality browser SpeechSynthesis fallback
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (mine !== token) return;
      const utterance = new SpeechSynthesisUtterance(trimmed);

      // Await voice list — browsers fire voiceschanged asynchronously.
      // getVoices() returns [] until loaded; without waiting we get the
      // lowest-quality default voice on first speak.
      const getLoadedVoices = (): Promise<SpeechSynthesisVoice[]> =>
        new Promise((res) => {
          const v = window.speechSynthesis.getVoices();
          if (v.length > 0) { res(v); return; }
          const handler = () => {
            res(window.speechSynthesis.getVoices());
            window.speechSynthesis.removeEventListener('voiceschanged', handler);
          };
          window.speechSynthesis.addEventListener('voiceschanged', handler);
          setTimeout(() => res([]), 1000); // fallback: speak with default voice
        });

      // Select natural sounding voice matching selected gender (Male/Female)
      try {
        const gender: VoiceGender = useAppStore.getState().settings.voiceGender || 'female';
        const voices = await getLoadedVoices();
        if (mine !== token) return; // another speak() won the race
        const bestVoice = getBestVoice(voices, gender);
        configureUtteranceForGender(utterance, gender, bestVoice);
      } catch {}

      if (mine !== token) return;

      utterance.onstart = () => {
        if (mine === token) set({ state: 'speaking', speakingId: id });
      };
      utterance.onend = () => {
        if (mine !== token) return;
        teardown();
        set({ state: 'idle', speakingId: null });
      };
      utterance.onerror = () => {
        if (mine !== token) return;
        teardown();
        set({ state: 'idle', speakingId: null, error: 'Voice playback interrupted', errorId: id });
      };

      try {
        window.speechSynthesis.speak(utterance);
        set({ state: 'speaking', speakingId: id });
        return;
      } catch (err) {
        teardown();
        set({
          state: 'idle',
          speakingId: null,
          error: err instanceof Error ? err.message : 'Speech synthesis failed',
          errorId: id,
        });
        return;
      }
    }

    teardown();
    set({
      state: 'idle',
      speakingId: null,
      error: 'Speech synthesis is not available in this browser',
      errorId: id,
    });
  },

  stop: () => {
    token += 1;
    teardown();
    set({ state: 'idle', speakingId: null, error: null, errorId: null });
  },
}));

/** Test seam: reset module-level playback handles between cases. */
export function __resetTtsForTests(): void {
  teardown();
  token = 0;
  healthProbe = null;
  useTtsStore.setState({
    state: 'idle',
    speakingId: null,
    error: null,
    errorId: null,
    available: null,
    autoSpokenId: null,
  });
}
