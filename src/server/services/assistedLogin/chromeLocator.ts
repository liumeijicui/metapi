import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ChromeCandidate = {
  path: string;
  label: string;
};

function windowsCandidates(env: NodeJS.ProcessEnv): ChromeCandidate[] {
  const programFiles = env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = env['LOCALAPPDATA'] || '';

  return [
    { path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), label: 'Google Chrome' },
    { path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'), label: 'Google Chrome' },
    ...(localAppData
      ? [{ path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'), label: 'Google Chrome' }]
      : []),
    { path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), label: 'Microsoft Edge' },
    { path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), label: 'Microsoft Edge' },
  ];
}

function macOSCandidates(): ChromeCandidate[] {
  return [
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', label: 'Google Chrome' },
    { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', label: 'Microsoft Edge' },
    { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', label: 'Chromium' },
  ];
}

function linuxCandidates(): ChromeCandidate[] {
  return [
    { path: '/usr/bin/google-chrome', label: 'Google Chrome' },
    { path: '/usr/bin/google-chrome-stable', label: 'Google Chrome' },
    { path: '/usr/bin/microsoft-edge', label: 'Microsoft Edge' },
    { path: '/usr/bin/chromium', label: 'Chromium' },
    { path: '/usr/bin/chromium-browser', label: 'Chromium' },
    { path: '/snap/bin/chromium', label: 'Chromium' },
  ];
}

export function resolveChromiumExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  configuredPath?: string,
): ChromeCandidate | null {
  const explicit = (configuredPath || '').trim();
  if (explicit) {
    return existsSync(explicit) ? { path: explicit, label: 'Configured browser' } : null;
  }

  const candidates = platform === 'win32'
    ? windowsCandidates(env)
    : platform === 'darwin'
      ? macOSCandidates()
      : linuxCandidates();

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}

