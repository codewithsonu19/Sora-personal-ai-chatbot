/**
 * Sora Voice Profiles & Gender Selection
 * Supports both Female and Male natural voices across browsers and OS.
 */

export type VoiceGender = 'female' | 'male';

export interface VoiceOption {
  id: string;
  name: string;
  gender: VoiceGender;
  tagline: string;
  avatar: string;
}

export const SORA_VOICE_OPTIONS: VoiceOption[] = [
  {
    id: 'sora-female',
    name: 'Sora (Female)',
    gender: 'female',
    tagline: 'Warm, empathetic, and gentle',
    avatar: '👩',
  },
  {
    id: 'sora-male',
    name: 'Sora (Male)',
    gender: 'male',
    tagline: 'Calm, thoughtful, and reassuring',
    avatar: '👨',
  },
];

const FEMALE_VOICE_KEYWORDS = [
  'natural', 'aria', 'jenny', 'zira', 'ana', 'michelle', 'samantha', 'victoria', 'karen', 'female'
];

const MALE_VOICE_KEYWORDS = [
  'natural', 'guy', 'christopher', 'david', 'mark', 'george', 'alex', 'daniel', 'male'
];

/**
 * Find the best native SpeechSynthesisVoice matching the target gender.
 */
export function getBestVoice(
  voices: SpeechSynthesisVoice[],
  gender: VoiceGender
): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null;

  const englishVoices = voices.filter((v) => v.lang.startsWith('en') || v.lang.includes('US') || v.lang.includes('GB'));
  const candidatePool = englishVoices.length > 0 ? englishVoices : voices;

  const keywords = gender === 'female' ? FEMALE_VOICE_KEYWORDS : MALE_VOICE_KEYWORDS;

  // 1. Look for explicit name match with keywords
  for (const keyword of keywords) {
    const match = candidatePool.find((v) => v.name.toLowerCase().includes(keyword));
    if (match) return match;
  }

  // 2. Fallback to any english voice
  return candidatePool[0] || voices[0] || null;
}

/**
 * Configure utterance pitch and rate tailored to gender for maximum realism.
 */
export function configureUtteranceForGender(
  utterance: SpeechSynthesisUtterance,
  gender: VoiceGender,
  voice: SpeechSynthesisVoice | null
): void {
  if (voice) {
    utterance.voice = voice;
  }

  if (gender === 'female') {
    utterance.pitch = 1.05;
    utterance.rate = 1.0;
  } else {
    utterance.pitch = 0.94;
    utterance.rate = 0.98;
  }
}
