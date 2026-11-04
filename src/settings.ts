export type Theme = 'system' | 'light' | 'dark';
export type Units = 'mm' | 'in' | 'pt';
export type Layout = 'continuous' | 'facing' | 'single';

export interface Settings {
  author: string;
  theme: Theme;
  nightPages: boolean;
  defaultZoom: 'width' | 'page' | '1';
  layout: Layout;
  rememberPosition: boolean;
  saveMode: 'annotations' | 'flatten';
  units: Units;
  snap: boolean;
  grid: boolean;
  gridSize: number;
  rulers: boolean;
  ocrLang: string;
}

const DEFAULTS: Settings = {
  author: '',
  theme: (localStorage.getItem('theme') as Theme) || 'system',
  nightPages: false,
  defaultZoom: 'width',
  layout: 'continuous',
  rememberPosition: true,
  saveMode: 'annotations',
  units: 'mm',
  snap: true,
  grid: false,
  gridSize: 10,
  rulers: false,
  ocrLang: 'eng',
};

const KEY = 'settings';
export const settings: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
export const settingsEvents = new EventTarget();

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  localStorage.setItem(KEY, JSON.stringify(settings));
  settingsEvents.dispatchEvent(new Event('change'));
}

// Other windows share localStorage; keep them in sync.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY || !e.newValue) return;
  Object.assign(settings, JSON.parse(e.newValue));
  settingsEvents.dispatchEvent(new Event('change'));
});

export const UNIT_PT: Record<Units, number> = { mm: 72 / 25.4, in: 72, pt: 1 };

export function formatLength(pt: number, units: Units = settings.units) {
  const v = pt / UNIT_PT[units];
  return `${v.toFixed(units === 'pt' ? 0 : units === 'in' ? 2 : 1)} ${units}`;
}

export function authorName() {
  return settings.author.trim() || 'Me';
}
