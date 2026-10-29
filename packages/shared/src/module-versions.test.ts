import { describe, expect, it } from 'vitest';
import { PLUGIN_ID_RE, defaultPluginVersion, groupPluginFamilies, parsePluginVersion } from './module-versions.js';

describe('parsePluginVersion', () => {
  it("l'id de base est la v1 de sa propre famille", () => {
    expect(parsePluginVersion('vm-view')).toEqual({ family: 'vm-view', version: 1 });
    expect(parsePluginVersion('storage')).toEqual({ family: 'storage', version: 1 });
  });

  it('le suffixe _vN donne famille + version', () => {
    expect(parsePluginVersion('vm-view_v2')).toEqual({ family: 'vm-view', version: 2 });
    expect(parsePluginVersion('storage_v10')).toEqual({ family: 'storage', version: 10 });
  });
});

describe('PLUGIN_ID_RE', () => {
  it('accepte les ids de base et les versions', () => {
    for (const id of ['hypervision', 'vm-view', 'vm-view_v2', 'storage_v12']) {
      expect(PLUGIN_ID_RE.test(id)).toBe(true);
    }
  });

  it("rejette les suffixes invalides", () => {
    for (const id of ['VM_v2', 'vm_inventory', 'vm-view_v', 'vm-view_vx', '_v2', 'vm-view_2']) {
      expect(PLUGIN_ID_RE.test(id)).toBe(false);
    }
  });
});

describe('defaultPluginVersion', () => {
  it('plusieurs versions : la plus récente est canonique', () => {
    expect(defaultPluginVersion('vm-view', ['vm-view', 'vm-view_v2'])).toBe('vm-view_v2');
  });

  it('tri par numéro (pas par ordre d’insertion ni lexicographique)', () => {
    expect(defaultPluginVersion('vm-view', ['vm-view_v2', 'vm-view', 'vm-view_v10'])).toBe(
      'vm-view_v10',
    );
  });

  it('version unique : c’est elle', () => {
    expect(defaultPluginVersion('storage', ['storage'])).toBe('storage');
  });

  it('liste vide : repli sur l’id de famille', () => {
    expect(defaultPluginVersion('vm-view', [])).toBe('vm-view');
  });
});

describe('groupPluginFamilies', () => {
  it('regroupe par famille, triées par version croissante', () => {
    expect(
      groupPluginFamilies(['vm-view_v2', 'storage', 'vm-view', 'network_v3', 'network']),
    ).toEqual([
      ['vm-view', ['vm-view', 'vm-view_v2']],
      ['storage', ['storage']],
      ['network', ['network', 'network_v3']],
    ]);
  });

  it('liste vide → aucun groupe', () => {
    expect(groupPluginFamilies([])).toEqual([]);
  });
});
