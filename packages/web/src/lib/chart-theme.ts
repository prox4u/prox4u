import type { Theme } from '../store/theme';

/**
 * Thème des graphiques ECharts selon le mode clair/sombre.
 * Les couleurs de série suivent le design system (bleu CPU, violet RAM,
 * ambre disk, émeraude RX) — légèrement plus claires en sombre.
 */
export interface ChartTheme {
  axisLabel: string;
  axisLine: string;
  splitLine: string;
  legend: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  cpu: string;
  ram: string;
  disk: string;
  /** I/O disque par VM : lecture (ambre) / écriture (orange) */
  diskRead: string;
  diskWrite: string;
  netIn: string;
  netOut: string;
  /** Capteurs nœuds (températures). */
  temp: string;
  gaugeTrack: string;
}

export function chartTheme(theme: Theme): ChartTheme {
  if (theme === 'dark') {
    return {
      axisLabel: '#64748b',
      axisLine: 'rgba(148,163,184,0.2)',
      splitLine: 'rgba(148,163,184,0.09)',
      legend: '#94a3b8',
      tooltipBg: '#1e2534',
      tooltipBorder: 'rgba(148,163,184,0.2)',
      tooltipText: '#f1f5f9',
      cpu: '#60a5fa',
      ram: '#a78bfa',
      disk: '#fbbf24',
      diskRead: '#fbbf24',
      diskWrite: '#fb923c',
      netIn: '#34d399',
      netOut: '#fbbf24',
      temp: '#f87171',
      gaugeTrack: 'rgba(148,163,184,0.15)',
    };
  }
  return {
    axisLabel: '#6b7280',
    axisLine: 'rgba(107,114,128,0.25)',
    splitLine: '#e5e7eb',
    legend: '#4b5563',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e5e7eb',
    tooltipText: '#111827',
    cpu: '#3b82f6',
    ram: '#8b5cf6',
    disk: '#f59e0b',
    diskRead: '#f59e0b',
    diskWrite: '#ea580c',
    netIn: '#10b981',
    netOut: '#f59e0b',
    temp: '#ef4444',
    gaugeTrack: 'rgba(107,114,128,0.15)',
  };
}
