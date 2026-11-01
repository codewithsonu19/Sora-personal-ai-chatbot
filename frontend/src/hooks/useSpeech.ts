import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const recognitionTextRef = useRef<string>('');

  // Check if speech backend or browser speech recognition is available
  useEffect(() => {
    fetchSpeechHealth()
      .then((health) => {
        if (health.available) {
          setAvailable(true);
        } else if (
          typeof window !== 'undefined' &&
          ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
        ) {
          setAvailable(true);
        } else {
          setAvailable(false);
        }
      })
      .catch(() => {
        if (
          typeof window !== 'undefined' &&
          ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
        ) {
          setAvailable(true);
        } else {
          setAvailable(false);
        }
      });
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    setError(null);
    recognitionTextRef.current = '';

    // If browser supports webkitSpeechRecognition, start it in parallel
    if (typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      try {
        const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new SpeechRec();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';
        rec.onresult = (event: any) => {
          let text = '';
          for (let i = 0; i < event.results.length; i++) {
            text += event.results[i][0].transcript;
          }
          recognitionTextRef.current = text;
        };
        rec.start();
        recognitionRef.current = rec;
      } catch {}
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      if (recognitionRef.current) {
        setState('recording');
        return;
      }
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
    } catch (err) {
      if (recognitionRef.current) {
        setState('recording');
        return;
      }
      setError('Microphone access denied');
      setState('idle');
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      // Stop browser speech recognition if running
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }

      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        // Fallback to web recognition text if recorder wasn't running
        if (recognitionTextRef.current.trim()) {
          setState('idle');
          resolve(recognitionTextRef.current.trim());
          return;
        }
        reject(new Error('Not recording'));
        return;
      }

      recorder.onstop = async () => {
        setState('transcribing');

        // Stop all audio tracks
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        try {
          const result = await transcribeAudio(blob);
          const finalResult = result.text?.trim() || recognitionTextRef.current.trim();
          setState('idle');
          resolve(finalResult);
        } catch (err) {
          // If server transcribe failed, check if browser speech recognition got text
          if (recognitionTextRef.current.trim()) {
            setState('idle');
            resolve(recognitionTextRef.current.trim());
            return;
          }
          setState('idle');
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setError(msg);
          reject(err);
        }
      };

      recorder.stop();
    });
  }, []);

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
