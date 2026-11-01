/**
 * useSpeech — reliable browser speech-to-text hook.
 *
 * Strategy (in priority order):
 *  1. Web Speech API (SpeechRecognition / webkitSpeechRecognition) — instant,
 *     zero-latency, works in Chrome / Edge with no server round-trip.
 *  2. faster-whisper backend transcription — used as fallback if Web Speech
 *     is not available (Firefox, Safari) or was denied.
 *
 * The hook always prefers Web Speech when available because it returns text
 * in real time without any upload delay.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

/** True when the browser exposes SpeechRecognition in any vendor prefix. */
function hasBrowserSpeech(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  );
}

function getSpeechRecognition(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  // Browser SpeechRecognition path
  const recRef = useRef<any>(null);
  const recTextRef = useRef<string>('');
  const recFinalRef = useRef<boolean>(false);

  // MediaRecorder path (fallback for Whisper upload)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Resolve promise when recognition ends
  const resolveRef = useRef<((text: string) => void) | null>(null);
  const rejectRef = useRef<((e: unknown) => void) | null>(null);

  // ── Availability check ──────────────────────────────────────────────
  useEffect(() => {
    if (hasBrowserSpeech()) {
      // Browser speech is always our primary — mark available immediately.
      setAvailable(true);
      return;
    }
    // No browser speech — probe the server Whisper backend.
    fetchSpeechHealth()
      .then((h) => setAvailable(h.available))
      .catch(() => setAvailable(false));
  }, []);

  // ── Cleanup helper ──────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (recRef.current) {
      try { recRef.current.abort(); } catch {}
      recRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    mediaRecorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    chunksRef.current = [];
    recTextRef.current = '';
    recFinalRef.current = false;
  }, []);

  // ── startRecording ──────────────────────────────────────────────────
  const startRecording = useCallback(async (): Promise<void> => {
    cleanup();
    setError(null);
    recTextRef.current = '';
    recFinalRef.current = false;

    const SpeechRec = getSpeechRecognition();

    if (SpeechRec) {
      // ── Path 1: Web Speech API ──────────────────────────────────────
      try {
        const rec = new SpeechRec();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';
        rec.maxAlternatives = 1;

        rec.onresult = (event: any) => {
          let final = '';
          let interim = '';
          for (let i = 0; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              final += t;
            } else {
              interim += t;
            }
          }
          // Keep best accumulated text
          recTextRef.current = (final || interim).trim();
        };

        rec.onerror = (e: any) => {
          // 'no-speech' is benign — user just hasn't spoken yet.
          if (e.error === 'no-speech') return;
          // 'not-allowed' means mic permission denied.
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            setError('Microphone permission denied. Please allow mic access in your browser.');
            setState('idle');
            resolveRef.current?.('');
          }
        };

        rec.onend = () => {
          // Resolve with whatever we accumulated.
          const text = recTextRef.current.trim();
          setState('idle');
          resolveRef.current?.(text);
          resolveRef.current = null;
          rejectRef.current = null;
        };

        rec.start();
        recRef.current = rec;
        setState('recording');
      } catch (err) {
        setError('Could not start microphone. Please check browser permissions.');
        setState('idle');
      }
    } else {
      // ── Path 2: MediaRecorder + Whisper backend ─────────────────────
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Microphone not supported in this browser');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start();
        mediaRecorderRef.current = recorder;
        setState('recording');
      } catch {
        setError('Microphone access denied');
        setState('idle');
      }
    }
  }, [cleanup]);

  // ── stopRecording ───────────────────────────────────────────────────
  const stopRecording = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current = reject;

      const SpeechRec = getSpeechRecognition();

      if (SpeechRec && recRef.current) {
        // Web Speech path — stopping fires the onend event which resolves.
        try {
          recRef.current.stop();
        } catch {
          // If stop throws the recognition already ended.
          const text = recTextRef.current.trim();
          setState('idle');
          resolve(text);
          resolveRef.current = null;
          rejectRef.current = null;
        }
        return;
      }

      // MediaRecorder path
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        setState('idle');
        resolve('');
        return;
      }

      recorder.onstop = async () => {
        setState('transcribing');
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        chunksRef.current = [];

        try {
          const result = await transcribeAudio(blob);
          setState('idle');
          resolve(result.text?.trim() ?? '');
        } catch (err) {
          setState('idle');
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setError(msg);
          reject(err);
        }
      };

      recorder.stop();
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => () => cleanup(), [cleanup]);

  return {
    state,
    error,
    available,
    startRecording,
    stopRecording,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
