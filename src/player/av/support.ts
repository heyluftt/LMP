import { extension as mediaExtension } from "../../lib/playerBrain";
import type { AvTrack } from "./types";

export const lmpAvContainerExtensions = new Set([
  "mp4",
  "m4v",
  "mov",
  "3gp",
  "3g2",
  "m4a",
  "mkv",
  "mka",
  "webm",
  "weba",
  "ts",
  "m2ts",
  "mts",
]);

export function lmpAvAvailable() {
  return (
    typeof VideoDecoder !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof EncodedVideoChunk !== "undefined" &&
    typeof EncodedAudioChunk !== "undefined" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

export function lmpAvSupportsPath(path: string | null | undefined) {
  return Boolean(path && lmpAvContainerExtensions.has(mediaExtension(path)));
}

export type VideoSupport = {
  supported: boolean;
  hardware: boolean;
  config: VideoDecoderConfig | null;
  reason: string | null;
};

export type AudioSupport = {
  supported: boolean;
  config: AudioDecoderConfig | null;
  reason: string | null;
};

function descriptionBytes(track: AvTrack) {
  return track.description && track.description.length > 0
    ? Uint8Array.from(track.description)
    : null;
}

export function videoDecoderConfig(
  track: AvTrack,
  hardware: HardwareAcceleration = "prefer-hardware",
): VideoDecoderConfig | null {
  if (!track.codec) {
    return null;
  }
  const config: VideoDecoderConfig = {
    codec: track.codec,
    hardwareAcceleration: hardware,
    optimizeForLatency: false,
  };
  if (track.width > 0 && track.height > 0) {
    config.codedWidth = track.width;
    config.codedHeight = track.height;
  }
  if (
    track.displayWidth > 0 &&
    track.displayHeight > 0 &&
    (track.displayWidth !== track.width || track.displayHeight !== track.height)
  ) {
    config.displayAspectWidth = track.displayWidth;
    config.displayAspectHeight = track.displayHeight;
  }
  const description = descriptionBytes(track);
  if (description && (track.codecFamily === "h264" || track.codecFamily === "hevc")) {
    config.description = description;
  }
  return config;
}

export function audioDecoderConfig(track: AvTrack): AudioDecoderConfig | null {
  if (!track.codec) {
    return null;
  }
  const config: AudioDecoderConfig = {
    codec: track.codec,
    sampleRate: track.sampleRate > 0 ? track.sampleRate : 48000,
    numberOfChannels: track.channels > 0 ? track.channels : 2,
  };
  const description = descriptionBytes(track);
  if (
    description &&
    (track.codecFamily === "aac" ||
      track.codecFamily === "opus" ||
      track.codecFamily === "vorbis" ||
      track.codecFamily === "flac")
  ) {
    config.description = description;
  }
  return config;
}

const videoSupportCache = new Map<string, Promise<VideoSupport>>();
const audioSupportCache = new Map<string, Promise<AudioSupport>>();

function videoCacheKey(track: AvTrack) {
  return `${track.codec}|${track.width}x${track.height}|${track.description?.length ?? 0}`;
}

export function probeVideoTrack(track: AvTrack): Promise<VideoSupport> {
  if (!track.codec) {
    return Promise.resolve({
      supported: false,
      hardware: false,
      config: null,
      reason: `${describeCodecFamily(track.codecFamily)} video is not supported by LMP AV.`,
    });
  }
  const key = videoCacheKey(track);
  const cached = videoSupportCache.get(key);
  if (cached) {
    return cached;
  }
  const probe = (async (): Promise<VideoSupport> => {
    if (!lmpAvAvailable()) {
      return { supported: false, hardware: false, config: null, reason: "WebCodecs is not available." };
    }
    for (const hardware of ["prefer-hardware", "no-preference"] as HardwareAcceleration[]) {
      const config = videoDecoderConfig(track, hardware);
      if (!config) {
        break;
      }
      try {
        const result = await VideoDecoder.isConfigSupported(config);
        if (result.supported) {
          return {
            supported: true,
            hardware: hardware === "prefer-hardware",
            config: result.config ? { ...config, ...result.config } : config,
            reason: null,
          };
        }
      } catch {
        // Try the next acceleration mode.
      }
    }
    return {
      supported: false,
      hardware: false,
      config: null,
      reason: `${track.codec} is not decodable on this system.`,
    };
  })();
  videoSupportCache.set(key, probe);
  return probe;
}

export function probeAudioTrack(track: AvTrack): Promise<AudioSupport> {
  if (!track.codec) {
    return Promise.resolve({
      supported: false,
      config: null,
      reason: `${describeCodecFamily(track.codecFamily)} audio is not supported by LMP AV.`,
    });
  }
  const key = `${track.codec}|${track.sampleRate}|${track.channels}|${track.description?.length ?? 0}`;
  const cached = audioSupportCache.get(key);
  if (cached) {
    return cached;
  }
  const probe = (async (): Promise<AudioSupport> => {
    const config = audioDecoderConfig(track);
    if (!config || !lmpAvAvailable()) {
      return { supported: false, config: null, reason: "WebCodecs is not available." };
    }
    try {
      const result = await AudioDecoder.isConfigSupported(config);
      if (result.supported) {
        return { supported: true, config, reason: null };
      }
    } catch {
      // Fall through.
    }
    return {
      supported: false,
      config: null,
      reason: `${track.codec} audio is not decodable on this system.`,
    };
  })();
  audioSupportCache.set(key, probe);
  return probe;
}

export function describeCodecFamily(family: string) {
  switch (family) {
    case "h264":
      return "H.264";
    case "hevc":
      return "HEVC";
    case "vp8":
      return "VP8";
    case "vp9":
      return "VP9";
    case "av1":
      return "AV1";
    case "aac":
      return "AAC";
    case "opus":
      return "Opus";
    case "vorbis":
      return "Vorbis";
    case "flac":
      return "FLAC";
    case "mp3":
      return "MP3";
    case "mp2":
      return "MPEG audio";
    case "ac3":
      return "AC-3";
    case "eac3":
      return "E-AC-3";
    case "dts":
      return "DTS";
    case "truehd":
      return "TrueHD";
    case "pcm":
      return "PCM";
    case "mpeg4":
      return "MPEG-4 Part 2";
    case "mpeg2":
      return "MPEG-2";
    default:
      return family.toUpperCase();
  }
}

export function describeTrack(track: AvTrack) {
  const parts: string[] = [describeCodecFamily(track.codecFamily)];
  if (track.kind === "video") {
    if (track.width && track.height) {
      parts.push(`${track.width}x${track.height}`);
    }
    if (track.frameRate) {
      parts.push(`${Math.round(track.frameRate * 100) / 100} fps`);
    }
  } else if (track.kind === "audio") {
    if (track.channels) {
      parts.push(
        track.channels === 1
          ? "mono"
          : track.channels === 2
            ? "stereo"
            : `${track.channels} ch`,
      );
    }
    if (track.sampleRate) {
      parts.push(`${(track.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`);
    }
  } else if (track.subtitleFormat) {
    parts.push(track.subtitleFormat.toUpperCase());
  }
  return parts.join(" · ");
}

export function trackLabel(track: AvTrack, index: number) {
  const base =
    track.name?.trim() ||
    (track.language ? languageName(track.language) : null) ||
    `${track.kind === "audio" ? "Audio" : track.kind === "video" ? "Video" : "Subtitle"} ${index + 1}`;
  return track.forced ? `${base} (forced)` : base;
}

const languageNames: Record<string, string> = {
  eng: "English",
  en: "English",
  deu: "Deutsch",
  ger: "Deutsch",
  de: "Deutsch",
  fra: "Français",
  fre: "Français",
  fr: "Français",
  spa: "Español",
  es: "Español",
  ita: "Italiano",
  it: "Italiano",
  jpn: "日本語",
  ja: "日本語",
  kor: "한국어",
  ko: "한국어",
  zho: "中文",
  chi: "中文",
  zh: "中文",
  rus: "Русский",
  ru: "Русский",
  por: "Português",
  pt: "Português",
  nld: "Nederlands",
  dut: "Nederlands",
  nl: "Nederlands",
  pol: "Polski",
  pl: "Polski",
  tur: "Türkçe",
  tr: "Türkçe",
  swe: "Svenska",
  sv: "Svenska",
  nor: "Norsk",
  no: "Norsk",
  dan: "Dansk",
  da: "Dansk",
  fin: "Suomi",
  fi: "Suomi",
  ces: "Čeština",
  cze: "Čeština",
  cs: "Čeština",
  hun: "Magyar",
  hu: "Magyar",
  ara: "العربية",
  ar: "العربية",
  heb: "עברית",
  he: "עברית",
  hin: "हिन्दी",
  hi: "हिन्दी",
  tha: "ไทย",
  th: "ไทย",
  ukr: "Українська",
  uk: "Українська",
};

export function languageName(code: string) {
  const normalized = code.toLowerCase().split(/[-_]/)[0] ?? code;
  return languageNames[normalized] ?? code.toUpperCase();
}
