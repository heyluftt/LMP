import { fileName, formatClock, isPlayablePath } from "../lib/playerBrain";
import type { Moment } from "./types";

const memoryKey = "lmp:memory";
const legacyMemoryKeys = ["lmp-one:memory"];
const recentLimit = 12;
const momentSnapWindow = 0.75;

type ResumeEntry = {
  position: number;
  duration: number;
  updatedAt: number;
};

type MemoryState = {
  recent: string[];
  resume: Record<string, ResumeEntry>;
  moments: Record<string, Moment[]>;
};

const emptyMemory: MemoryState = {
  recent: [],
  resume: {},
  moments: {},
};

function readMemory(): MemoryState {
  try {
    const keys = [memoryKey, ...legacyMemoryKeys];
    const stored = keys
      .map((key) => ({ key, value: window.localStorage.getItem(key) }))
      .find((entry) => entry.value);

    if (!stored?.value) {
      return emptyMemory;
    }
    const parsed = JSON.parse(stored.value) as Partial<MemoryState>;
    const memory = {
      recent: parsed.recent ?? [],
      resume: parsed.resume ?? {},
      moments: parsed.moments ?? {},
    };
    if (stored.key !== memoryKey) {
      writeMemory(memory);
    }
    return memory;
  } catch {
    return emptyMemory;
  }
}

function writeMemory(memory: MemoryState) {
  window.localStorage.setItem(memoryKey, JSON.stringify(memory));
  for (const key of legacyMemoryKeys) {
    window.localStorage.removeItem(key);
  }
}

export function readRecent() {
  return readMemory().recent.filter(isPlayablePath).slice(0, recentLimit);
}

export function rememberMedia(path: string) {
  if (!isPlayablePath(path)) {
    return readRecent();
  }

  const memory = readMemory();
  memory.recent = [path, ...memory.recent.filter((item) => item !== path)].slice(0, recentLimit);
  writeMemory(memory);
  return memory.recent;
}

export function clearRecent() {
  const memory = readMemory();
  memory.recent = [];
  writeMemory(memory);
  return memory.recent;
}

export function getResume(path: string) {
  return readMemory().resume[path] ?? null;
}

export function saveResume(path: string, position: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }

  const memory = readMemory();
  if (position < 5) {
    return;
  }

  if (duration - position < 8) {
    delete memory.resume[path];
  } else {
    memory.resume[path] = {
      position,
      duration,
      updatedAt: Date.now(),
    };
  }
  writeMemory(memory);
}

export function readMoments(path: string | null) {
  if (!path) {
    return [];
  }
  return [...(readMemory().moments[path] ?? [])].sort((a, b) => a.at - b.at);
}

export function addMoment(path: string, at: number) {
  const memory = readMemory();
  const moments = memory.moments[path] ?? [];
  const existing = moments.find((moment) => Math.abs(moment.at - at) <= momentSnapWindow);

  if (existing) {
    return [...moments].sort((a, b) => a.at - b.at);
  }

  const next: Moment = {
    id: `${Date.now()}-${Math.round(at * 1000)}`,
    at,
    label: `${fileName(path)} at ${formatClock(at)}`,
    createdAt: Date.now(),
  };

  memory.moments[path] = [...moments, next].sort((a, b) => a.at - b.at);
  writeMemory(memory);
  return memory.moments[path];
}

export function removeMoment(path: string, id: string) {
  const memory = readMemory();
  memory.moments[path] = (memory.moments[path] ?? []).filter((moment) => moment.id !== id);
  writeMemory(memory);
  return memory.moments[path];
}

export function findAdjacentMoment(moments: Moment[], position: number, direction: -1 | 1) {
  if (direction > 0) {
    return moments.find((moment) => moment.at > position + 1.5) ?? null;
  }

  return [...moments].reverse().find((moment) => moment.at < position - 1.5) ?? null;
}
