import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Filter, HardDrive, RefreshCw, Thermometer, TriangleAlert, Zap } from 'lucide-react';
import type { NodeSensorsResponse } from '@prox4u/shared';
import { fetchNodeSensors } from '../../../core/api/apiClient';
import { Card, CardContent } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';

/** Sections affichables (filtre multi-choix). */
type SectionId = 'smart' | 'sensors' | 'zfs' | 'units';
const SECTIONS: SectionId[] = ['smart', 'sensors', 'zfs', 'units'];

function toneForHealth(healthOk: boolean): string {
  return healthOk ? 'bg-ok/15 text-ok' : 'bg-crit/15 text-crit';
}

function toneForTemp(tempC: number | null): string {
  if (tempC === null) return 'bg-muted text-muted-foreground';
  if (tempC >= 80) return 'bg-crit/15 text-crit';
  if (tempC >= 60) return 'bg-warn/15 text-warn';
  return 'bg-ok/15 text-ok';
}

/**
 * Filtre colonne multi-choix : dropdown avec checkboxes, valeurs extraites des données.
 * Position fixe (pas d'overflow du tableau) : le menu apparaît en position:fixed
 * calculé depuis le bounding rect du bouton.
 * Option « Tous » en haut : coche = tout sélectionner, décoche = tout libérer.
 */
function MultiFilter({ label, values, selected, onChange }: {
  label: string;
  values: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const activeCount = selected.size;
  const allSelected = values.length > 0 && values.every((v) => selected.has(v));

  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };

  const toggleAll = () => {
    if (allSelected) {
      onChange(new Set());
    } else {
      onChange(new Set(values));
    }
  };

  const handleClick = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleClick}
        className={`flex w-full items-center justify-between gap-1 rounded border px-2 py-1 text-xs ${activeCount > 0 ? 'border-primary text-primary' : 'border-input text-muted-foreground'}`}
      >
        <span className="truncate">{label}{activeCount > 0 ? ` (${activeCount})` : ''}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 max-h-48 w-44 overflow-auto rounded-md border border-border p-1 shadow-lg"
            style={{ top: pos.top, left: pos.left, backgroundColor: '#0f1117' }}
          >
            {/* Option « Tous » */}
            <label className="flex cursor-pointer items-center gap-2 rounded border-b px-2 py-1.5 text-xs font-medium hover:bg-white/5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-3 w-3 rounded border-input"
              />
              <span>Tous</span>
            </label>
            {values.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">—</p>}
            {values.map((v) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={selected.has(v)}
                  onChange={() => toggle(v)}
                  className="h-3 w-3 rounded border-input"
                />
                <span className="truncate">{v}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Page Node Sensors — vue d'ensemble des métriques locales Telegraf par nœud.
 * Filtre multi-choix des sections + filtres colonnes (liste d'états, choix multiple)
 * sur chaque tableau.
 */
export function NodeSensorsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<NodeSensorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibleSections, setVisibleSections] = useState<Set<SectionId>>(new Set(SECTIONS));
  const [filterOpen, setFilterOpen] = useState(false);

  // Filtres colonnes : Set de valeurs sélectionnées (vide = tout afficher)
  const [smartF, setSmartF] = useState<Record<string, Set<string>>>({});
  const [sensorF, setSensorF] = useState<Record<string, Set<string>>>({});
  const [zfsF, setZfsF] = useState<Record<string, Set<string>>>({});
  const [unitF, setUnitF] = useState<Record<string, Set<string>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchNodeSensors();
      setData(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleSection = (id: SectionId) => {
    setVisibleSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sectionLabels: Record<SectionId, string> = useMemo(() => ({
    smart: t('nodeSensors.smart'),
    sensors: t('nodeSensors.sensors'),
    zfs: t('nodeSensors.zfs'),
    units: t('nodeSensors.failedUnits'),
  }), [t]);

  // Valeurs uniques pour les filtres
  const smartNodeValues = useMemo(() => data ? [...new Set(data.smart.map((d) => d.node))].sort() : [], [data]);
  const smartDeviceValues = useMemo(() => data ? [...new Set(data.smart.map((d) => d.device))].sort() : [], [data]);
  const smartModelValues = useMemo(() => data ? [...new Set(data.smart.map((d) => d.model ?? '—'))].sort() : [], [data]);
  const smartHealthValues = useMemo(() => data ? [...new Set(data.smart.map((d) => d.healthOk ? t('nodeSensors.healthy') : t('nodeSensors.unhealthy')))] : [], [data, t]);

  const sensorNodeValues = useMemo(() => data ? [...new Set(data.sensors.filter((s) => s.tempInput !== null).map((s) => s.node))].sort() : [], [data]);
  const sensorChipValues = useMemo(() => data ? [...new Set(data.sensors.filter((s) => s.tempInput !== null).map((s) => s.chip))].sort() : [], [data]);
  const sensorFeatureValues = useMemo(() => data ? [...new Set(data.sensors.filter((s) => s.tempInput !== null).map((s) => s.feature))].sort() : [], [data]);

  const zfsNodeValues = useMemo(() => data ? [...new Set(data.zfs.map((z) => z.node))].sort() : [], [data]);

  const unitNodeValues = useMemo(() => data ? [...new Set(data.failedUnits.map((u) => u.node))].sort() : [], [data]);
  const unitNameValues = useMemo(() => data ? [...new Set(data.failedUnits.map((u) => u.name))].sort() : [], [data]);
  const unitStateValues = useMemo(() => data ? [...new Set(data.failedUnits.map((u) => u.active))].sort() : [], [data]);
  const unitLoadValues = useMemo(() => data ? [...new Set(data.failedUnits.map((u) => u.load))].sort() : [], [data]);

  // Filtrage : une ligne passe si pour chaque colonne avec sélection, sa valeur est dans le Set
  function matches(row: Record<string, string>, filters: Record<string, Set<string>>): boolean {
    for (const [col, selected] of Object.entries(filters)) {
      if (selected.size === 0) continue; // pas de filtre sur cette colonne
      if (!selected.has(row[col])) return false;
    }
    return true;
  }

  const filteredSmart = useMemo(() => {
    if (!data) return [];
    return data.smart.filter((d) => matches(
      { node: d.node, device: d.device, model: d.model ?? '—', health: d.healthOk ? t('nodeSensors.healthy') : t('nodeSensors.unhealthy') },
      smartF,
    ));
  }, [data, smartF, t]);

  const filteredSensors = useMemo(() => {
    if (!data) return [];
    return data.sensors.filter((s) => s.tempInput !== null).filter((s) => matches(
      { node: s.node, chip: s.chip, feature: s.feature },
      sensorF,
    ));
  }, [data, sensorF]);

  const filteredZfs = useMemo(() => {
    if (!data) return [];
    return data.zfs.filter((z) => matches({ node: z.node }, zfsF));
  }, [data, zfsF]);

  const filteredUnits = useMemo(() => {
    if (!data) return [];
    return data.failedUnits.filter((u) => matches(
      { node: u.node, name: u.name, state: u.active, load: u.load },
      unitF,
    ));
  }, [data, unitF]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-crit">{t('nodeSensors.error', { msg: error })}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void load()}>
            <RefreshCw className="mr-1 h-3 w-3" /> {t('nodeSensors.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.source === 'empty') {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">{t('nodeSensors.noData')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('nodeSensors.title')}</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button variant="outline" size="sm" onClick={() => setFilterOpen((v) => !v)}>
              <Filter className="mr-1 h-3 w-3" /> {t('nodeSensors.filter')}
              <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border p-2 shadow-lg" style={{ backgroundColor: '#0f1117' }}>
                  {/* Option « Tous » */}
                  <label className="flex cursor-pointer items-center gap-2 rounded border-b px-2 py-1.5 text-sm font-medium hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={SECTIONS.every((id) => visibleSections.has(id))}
                      onChange={() => {
                        const all = SECTIONS.every((id) => visibleSections.has(id));
                        setVisibleSections(all ? new Set() : new Set(SECTIONS));
                      }}
                      className="h-4 w-4 rounded border-input"
                    />
                    <span>Toutes</span>
                  </label>
                  {SECTIONS.map((id) => (
                    <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/5">
                      <input
                        type="checkbox"
                        checked={visibleSections.has(id)}
                        onChange={() => toggleSection(id)}
                        className="h-4 w-4 rounded border-input"
                      />
                      {sectionLabels[id]}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="mr-1 h-3 w-3" /> {t('nodeSensors.refresh')}
          </Button>
        </div>
      </div>

      {/* SMART disques */}
      {visibleSections.has('smart') && (
        <Card>
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              <h2 className="text-lg font-semibold">{t('nodeSensors.smart')}</h2>
              <span className="text-xs text-muted-foreground">({filteredSmart.length}/{data.smart.length})</span>
            </div>
            {data.smart.length === 0 ? (
              <p className="text-muted-foreground">{t('nodeSensors.noSmart')}</p>
            ) : filteredSmart.length === 0 ? (
              <p className="text-muted-foreground">{t('nodeSensors.noMatch')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32"><MultiFilter label={t('nodeSensors.node')} values={smartNodeValues} selected={smartF.node ?? new Set()} onChange={(s) => setSmartF((p) => ({ ...p, node: s }))} /></TableHead>
                    <TableHead className="w-28"><MultiFilter label={t('nodeSensors.device')} values={smartDeviceValues} selected={smartF.device ?? new Set()} onChange={(s) => setSmartF((p) => ({ ...p, device: s }))} /></TableHead>
                    <TableHead className="w-40"><MultiFilter label={t('nodeSensors.model')} values={smartModelValues} selected={smartF.model ?? new Set()} onChange={(s) => setSmartF((p) => ({ ...p, model: s }))} /></TableHead>
                    <TableHead className="w-28"><MultiFilter label={t('nodeSensors.health')} values={smartHealthValues} selected={smartF.health ?? new Set()} onChange={(s) => setSmartF((p) => ({ ...p, health: s }))} /></TableHead>
                    <TableHead>{t('nodeSensors.temp')}</TableHead>
                    <TableHead>{t('nodeSensors.hours')}</TableHead>
                    <TableHead>{t('nodeSensors.wear')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSmart.map((d) => (
                    <TableRow key={`${d.node}/${d.device}`}>
                      <TableCell className="font-medium">{d.node}</TableCell>
                      <TableCell>{d.device}</TableCell>
                      <TableCell className="max-w-40 truncate">{d.model ?? '—'}</TableCell>
                      <TableCell>
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${toneForHealth(d.healthOk)}`}>
                          {d.healthOk ? t('nodeSensors.healthy') : t('nodeSensors.unhealthy')}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${toneForTemp(d.tempC)}`}>
                          {d.tempC !== null ? `${d.tempC}°C` : '—'}
                        </span>
                      </TableCell>
                      <TableCell>{d.powerOnHours !== null ? `${d.powerOnHours} h` : '—'}</TableCell>
                      <TableCell>{d.percentageUsed !== null ? `${d.percentageUsed}%` : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Capteurs */}
      {visibleSections.has('sensors') && (
        <Card>
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <Thermometer className="h-4 w-4" />
              <h2 className="text-lg font-semibold">{t('nodeSensors.sensors')}</h2>
              <span className="text-xs text-muted-foreground">({filteredSensors.length}/{data.sensors.filter((s) => s.tempInput !== null).length})</span>
            </div>
            {data.sensors.length === 0 ? (
              <p className="text-muted-foreground">{t('nodeSensors.noSensors')}</p>
            ) : filteredSensors.length === 0 ? (
              <p className="text-muted-foreground">{t('nodeSensors.noMatch')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32"><MultiFilter label={t('nodeSensors.node')} values={sensorNodeValues} selected={sensorF.node ?? new Set()} onChange={(s) => setSensorF((p) => ({ ...p, node: s }))} /></TableHead>
                    <TableHead className="w-36"><MultiFilter label={t('nodeSensors.chip')} values={sensorChipValues} selected={sensorF.chip ?? new Set()} onChange={(s) => setSensorF((p) => ({ ...p, chip: s }))} /></TableHead>
                    <TableHead className="w-32"><MultiFilter label={t('nodeSensors.feature')} values={sensorFeatureValues} selected={sensorF.feature ?? new Set()} onChange={(s) => setSensorF((p) => ({ ...p, feature: s }))} /></TableHead>
                    <TableHead>{t('nodeSensors.temp')}</TableHead>
                    <TableHead>{t('nodeSensors.tempCrit')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSensors.map((s) => (
                    <TableRow key={`${s.node}/${s.chip}/${s.feature}`}>
                      <TableCell className="font-medium">{s.node}</TableCell>
                      <TableCell>{s.chip}</TableCell>
                      <TableCell>{s.feature}</TableCell>
                      <TableCell>
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${toneForTemp(s.tempInput)}`}>
                          {s.tempInput}°C
                        </span>
                      </TableCell>
                      <TableCell>{s.tempCrit !== null ? `${s.tempCrit}°C` : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* ZFS ARC */}
      {visibleSections.has('zfs') && (
        <Card>
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <Zap className="h-4 w-4" />
              <h2 className="text-lg font-semibold">{t('nodeSensors.zfs')}</h2>
              <span className="text-xs text-muted-foreground">({filteredZfs.length}/{data.zfs.length})</span>
            </div>
            {data.zfs.length === 0 ? (
              <p className="text-muted-foreground">{t('nodeSensors.noZfs')}</p>
            ) : filteredZfs.length === 0 ? (
              <p className="text-muted-foreground">{t('nodeSensors.noMatch')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32"><MultiFilter label={t('nodeSensors.node')} values={zfsNodeValues} selected={zfsF.node ?? new Set()} onChange={(s) => setZfsF((p) => ({ ...p, node: s }))} /></TableHead>
                    <TableHead>{t('nodeSensors.arcHits')}</TableHead>
                    <TableHead>{t('nodeSensors.arcMisses')}</TableHead>
                    <TableHead>{t('nodeSensors.arcSize')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredZfs.map((z) => (
                    <TableRow key={z.node}>
                      <TableCell className="font-medium">{z.node}</TableCell>
                      <TableCell>{z.arcHits?.toLocaleString() ?? '—'}</TableCell>
                      <TableCell>{z.arcMisses?.toLocaleString() ?? '—'}</TableCell>
                      <TableCell>{z.arcSize !== null ? `${(z.arcSize / 1024 / 1024 / 1024).toFixed(1)} Go` : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Unités systemd en échec */}
      {visibleSections.has('units') && (
        <Card>
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <TriangleAlert className="h-4 w-4" />
              <h2 className="text-lg font-semibold">{t('nodeSensors.failedUnits')}</h2>
              <span className="text-xs text-muted-foreground">({filteredUnits.length}/{data.failedUnits.length})</span>
            </div>
            {data.failedUnits.length === 0 ? (
              <p className="text-ok">{t('nodeSensors.noFailedUnits')}</p>
            ) : filteredUnits.length === 0 ? (
              <p className="text-muted-foreground">{t('nodeSensors.noMatch')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32"><MultiFilter label={t('nodeSensors.node')} values={unitNodeValues} selected={unitF.node ?? new Set()} onChange={(s) => setUnitF((p) => ({ ...p, node: s }))} /></TableHead>
                    <TableHead className="w-48"><MultiFilter label={t('nodeSensors.unit')} values={unitNameValues} selected={unitF.name ?? new Set()} onChange={(s) => setUnitF((p) => ({ ...p, name: s }))} /></TableHead>
                    <TableHead className="w-28"><MultiFilter label={t('nodeSensors.state')} values={unitStateValues} selected={unitF.state ?? new Set()} onChange={(s) => setUnitF((p) => ({ ...p, state: s }))} /></TableHead>
                    <TableHead className="w-28"><MultiFilter label={t('nodeSensors.loadState')} values={unitLoadValues} selected={unitF.load ?? new Set()} onChange={(s) => setUnitF((p) => ({ ...p, load: s }))} /></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUnits.map((u) => (
                    <TableRow key={`${u.node}/${u.name}`}>
                      <TableCell className="font-medium">{u.node}</TableCell>
                      <TableCell className="font-mono text-sm">{u.name}</TableCell>
                      <TableCell>
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${u.active === 'failed' ? 'bg-crit/15 text-crit' : 'bg-warn/15 text-warn'}`}>
                          {u.active}
                        </span>
                      </TableCell>
                      <TableCell>{u.load}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
