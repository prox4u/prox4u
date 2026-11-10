import { describe, expect, it } from 'vitest';
import { effectiveSensorThreshold, sensorKey, smartHealthTone, smartTempDisplay, tempTone } from './node-sensors.js';
import type { SensorReading } from './node-sensors.js';

const reading = (over: Partial<SensorReading> = {}): SensorReading => ({
  node: 'proxmox',
  chip: 'amdgpu-pci-2300',
  feature: 'mem',
  tempInput: 70,
  tempCrit: 110,
  fanInput: null,
  inInput: null,
  lastSeen: 0,
  ...over,
});

describe('sensorKey', () => {
  it('clé = node/chip/feature', () => {
    expect(sensorKey(reading())).toBe('proxmox/amdgpu-pci-2300/mem');
  });
  it('clé stable pour le même capteur', () => {
    expect(sensorKey(reading())).toBe(sensorKey(reading({ tempInput: 99 })));
  });
});

describe('effectiveSensorThreshold', () => {
  it('seuil perso si défini', () => {
    expect(effectiveSensorThreshold(reading(), { 'proxmox/amdgpu-pci-2300/mem': 85 })).toBe(85);
  });
  it('sinon seuil firmware', () => {
    expect(effectiveSensorThreshold(reading(), {})).toBe(110);
  });
  it('perso l\'emporte même si firmware est nul', () => {
    expect(effectiveSensorThreshold(reading({ tempCrit: null }), { 'proxmox/amdgpu-pci-2300/mem': 85 })).toBe(85);
  });
  it('null si ni perso ni firmware', () => {
    expect(effectiveSensorThreshold(reading({ tempCrit: null }), {})).toBeNull();
  });
});

describe('tempTone', () => {
  it('na sans température', () => {
    expect(tempTone(null, 85)).toBe('na');
  });
  it('crit si temp ≥ seuil effectif', () => {
    expect(tempTone(85, 85)).toBe('crit');
    expect(tempTone(90, 85)).toBe('crit');
  });
  it('warn dans la marge de 20 °C sous le seuil', () => {
    expect(tempTone(70, 85)).toBe('warn');
    expect(tempTone(66, 85)).toBe('warn'); // 85-20 = 65 → 66 ≥ 65
    expect(tempTone(64, 85)).toBe('ok');   // 64 < 65
  });
  it('ok en dessous de la marge', () => {
    expect(tempTone(50, 85)).toBe('ok');
  });
  it('repli historique 80/60 sans seuil effectif', () => {
    expect(tempTone(90, null)).toBe('crit');
    expect(tempTone(70, null)).toBe('warn');
    expect(tempTone(50, null)).toBe('ok');
  });
  it('un seuil perso bas alerme plus tôt que le firmware', () => {
    // firmware 110, perso 80 : 82 °C = crit (avant le correctif, 82 < 110 serait « ok »)
    const r = reading({ tempInput: 82, tempCrit: 110 });
    expect(tempTone(82, effectiveSensorThreshold(r, { 'proxmox/amdgpu-pci-2300/mem': 80 }))).toBe('crit');
    // sans perso : 82 < 110 → warn (marge 110-20=90 → 82 < 90 → ok en fait)
    expect(tempTone(82, effectiveSensorThreshold(r, {}))).toBe('ok');
  });
});

describe('smartHealthTone (tri-state SMART)', () => {
  it('true → ok (SMART PASSED)', () => {
    expect(smartHealthTone(true)).toBe('ok');
  });
  it('false → crit (SMART FAILED — un disque qui échoue vraiment)', () => {
    expect(smartHealthTone(false)).toBe('crit');
  });
  it('null → unknown (pas de SMART : disque virtuel / RAID / illisible — PAS un échec)', () => {
    expect(smartHealthTone(null)).toBe('unknown');
  });
});

describe('smartTempDisplay (0 °C = pas de lecture)', () => {
  it('null → null (affichage « — »)', () => {
    expect(smartTempDisplay(null).value).toBeNull();
  });
  it('0 → null (aucun disque réel à 0 °C : disque virtuel / RAID)', () => {
    expect(smartTempDisplay(0).value).toBeNull();
  });
  it('température réelle conservée', () => {
    expect(smartTempDisplay(35).value).toBe(35);
    expect(smartTempDisplay(88).value).toBe(88);
  });
});
