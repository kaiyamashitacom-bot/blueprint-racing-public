// 音の設定 (効果音・曲の入/切と音量)。この端末だけに残す (localStorage の bpr.audio.v1)
// 決まりの数は全部 仮: 曲 入・効果音 入・音量 0.6 (曲はさらに小さく鳴らす、core.ts の MUSIC_LEVEL)

export interface AudioSettings {
  sfx: boolean;
  music: boolean;
  /** 全体の音量 0..1 */
  volume: number;
}

export const AUDIO_KEY = "bpr.audio.v1";
export const DEFAULT_AUDIO: Readonly<AudioSettings> = { sfx: true, music: true, volume: 0.6 };

/** 保存した文字から読む。壊れていたら決まりの値 */
export function parseAudioSettings(raw: string | null | undefined): AudioSettings {
  const out: AudioSettings = { ...DEFAULT_AUDIO };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof AudioSettings, unknown>> | null;
    if (!v || typeof v !== "object") return out;
    if (typeof v.sfx === "boolean") out.sfx = v.sfx;
    if (typeof v.music === "boolean") out.music = v.music;
    if (typeof v.volume === "number" && Number.isFinite(v.volume)) out.volume = Math.max(0, Math.min(1, v.volume));
  } catch {
    /* 決まりの値のまま */
  }
  return out;
}

export function loadAudioSettings(): AudioSettings {
  try {
    return parseAudioSettings(localStorage.getItem(AUDIO_KEY));
  } catch {
    return { ...DEFAULT_AUDIO };
  }
}

export function saveAudioSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify({ sfx: s.sfx, music: s.music, volume: Math.round(s.volume * 100) / 100 }));
  } catch {
    /* 残せなくても鳴らすのは続ける */
  }
}
