import { describe, expect, it } from 'vitest';
import { computeInfluxSizing, SIZING_CONSTANTS } from './influx-sizing.js';

describe('computeInfluxSizing (P3 — calculateur de dimensionnement, GitHub #19)', () => {
  it('petit parc (10 VMs, 2 nœuds) : taux + défauts conservés', () => {
    const r = computeInfluxSizing({ vms: 10, nodes: 2 });
    // 1 globale + 1 endpoint + 2×2 nœuds + 10×3 VMs = 36 lignes/tick
    expect(r.linesPerTick).toBe(36);
    expect(r.linesPerMinute).toBe(36); // tick 60 s
    expect(r.linesPerDay).toBe(36 * 1440); // 86400/60 = 1440 ticks/j
    // petits parcs : les défauts actuels suffisent
    expect(r.flushMaxLines).toBe(1000);
    expect(r.queueMax).toBe(20_000);
    expect(r.flushDelayMs).toBe(25);
  });

  it('parc 500 VMs : flushMaxLines monté (batcher le tick), queueMax au plancher', () => {
    const r = computeInfluxSizing({ vms: 500, nodes: 10, endpoints: 2, datastores: 5 });
    // 1 + 2 + 10×2 + 500×3 + 5 = 1528 lignes/tick
    expect(r.linesPerTick).toBe(1528);
    // flushMaxLines = max(1000, roundUp(1528×1.5, 100)) = 2300
    expect(r.flushMaxLines).toBe(2300);
    // queueMax = max(20000, roundUp(1528×10, 1000)) = 20000 (plancher)
    expect(r.queueMax).toBe(20_000);
  });

  it('très grand parc (2000 VMs) : queueMax monté (10 ticks de headroom)', () => {
    const r = computeInfluxSizing({ vms: 2000, nodes: 20, endpoints: 4, datastores: 10 });
    // 1 + 4 + 20×2 + 2000×3 + 10 = 6055 lignes/tick
    expect(r.linesPerTick).toBe(6055);
    expect(r.flushMaxLines).toBe(9100); // roundUp(6055×1.5, 100)
    expect(r.queueMax).toBe(61_000); // roundUp(6055×10, 1000)
  });

  it('config requête indépendante du parc (constante)', () => {
    const small = computeInfluxSizing({ vms: 1, nodes: 1 });
    const large = computeInfluxSizing({ vms: 5000, nodes: 50 });
    for (const r of [small, large]) {
      expect(r.queryFileLimit).toBe(10_000);
      expect(r.maxQueryWindowDays).toBe(69); // floor(10000/144)
      expect(r.chunkDays).toBe(30);
      expect(r.chunkFiles).toBe(4320);
      expect(r.fileHeadroom).toBe('ok'); // 4320/10000 = 0.43
    }
  });

  it('rétention recommandée : raw 31d, consolidated infinie', () => {
    const r = computeInfluxSizing({ vms: 10, nodes: 1 });
    expect(r.rawRetention).toBe('31d');
    expect(r.consolidatedRetention).toBe('infinie');
  });

  it('tick court (15 s) : taux /min et /j multiplié', () => {
    const r = computeInfluxSizing({ vms: 10, nodes: 2, tickSeconds: 15 });
    expect(r.linesPerTick).toBe(36);
    expect(r.linesPerMinute).toBe(36 * 4); // 60/15 = 4 ticks/min
    expect(r.linesPerDay).toBe(36 * 5760); // 86400/15 = 5760 ticks/j
  });

  it('parc vide (0 VMs, 0 nœuds) : seulement les lignes de base', () => {
    const r = computeInfluxSizing({ vms: 0, nodes: 0 });
    // 1 globale + 1 endpoint = 2 lignes/tick
    expect(r.linesPerTick).toBe(2);
    expect(r.flushMaxLines).toBe(1000);
    expect(r.queueMax).toBe(20_000);
  });

  it('valeurs négatives bornées à 0', () => {
    const r = computeInfluxSizing({ vms: -5, nodes: -2 });
    expect(r.linesPerTick).toBe(2); // base seulement
  });

  it('warnings : config actuelle sous-dimensionnée', () => {
    const r = computeInfluxSizing({
      vms: 2000,
      nodes: 20,
      endpoints: 4,
      datastores: 10,
      current: { queueMax: 20_000, flushMaxLines: 1000, queryFileLimit: 10_000 },
    });
    // flushMaxLines 1000 < 9100 → warning ; queueMax 20000 < 61000 → warning ;
    // queryFileLimit 10000 = 10000 → pas de warning.
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/flushMaxLines/);
    expect(r.warnings[1]).toMatch(/queueMax/);
  });

  it('warnings : config actuelle suffisante → aucun warning', () => {
    const r = computeInfluxSizing({
      vms: 10,
      nodes: 2,
      current: { queueMax: 50_000, flushMaxLines: 5000, queryFileLimit: 20_000 },
    });
    expect(r.warnings).toEqual([]);
  });

  it('justification : 5 lignes, 1ʳᵉ mentionne le taux', () => {
    const r = computeInfluxSizing({ vms: 100, nodes: 4 });
    expect(r.justification).toHaveLength(5);
    expect(r.justification[0]).toMatch(/lignes\/tick/);
    expect(r.justification[1]).toMatch(/flushMaxLines/);
    expect(r.justification[2]).toMatch(/queueMax/);
    expect(r.justification[3]).toMatch(/query-file-limit/);
    expect(r.justification[4]).toMatch(/Rétention/);
  });

  it('SIZING_CONSTANTS : valeurs cohérentes avec le plan', () => {
    expect(SIZING_CONSTANTS.filesPerDayPerTable).toBe(144);
    expect(SIZING_CONSTANTS.queryFileLimit).toBe(10_000);
    expect(SIZING_CONSTANTS.chunkDays).toBe(30);
    expect(SIZING_CONSTANTS.perVm).toBe(3);
    expect(SIZING_CONSTANTS.perNode).toBe(2);
  });
});
