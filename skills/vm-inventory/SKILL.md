---
name: vm-inventory
description: Base de connaissance du plugin Inventaire VM de Prox4u — page /vms : arborescence vCenter (Datacenter → cluster → nœud), tableau multi-endpoints filtrable/triable (VMs + LXC, live 5 s), panneau détail à onglets (Configuration / Réseau / Snapshots) via GET /api/vm-config. Lecture seule (pas d'actions power). Deux versions : v1 (id vm-inventory) et v2 (vm-inventory_v2, + bouton « Console web » vers l'UI PVE). Use when working on the vm-inventory plugin (packages/web/src/plugins/vm-inventory/ ou vm-inventory_v2/), the /vms page, its components (vm-tree, vm-table, vm-detail), or the /api/vm-config endpoint.
---

# Inventaire VM — Base de connaissance

Page `/vms` : **inventaire des VMs et conteneurs LXC** du parc multi-endpoints, présentation type vCenter — arborescence `Datacenter → cluster (endpoint) → nœud` à gauche, tableau filtrable au centre, panneau détail à onglets à droite au clic sur une ligne. **Lecture seule** : les tokens PVE sont en lecture seule (`ManagerReader`) ; les actions power (start/stop/reboot) sont une itération dédiée (token écriture + endpoints POST + UI de confirmation).

> Architecture globale : voir le skill `general`. Contrat API : skill `api` (`/api/vm-config`). Fonctions pures : skill `shared` (`vm-inventory.ts`).

## 1. Manifest (`index.ts`)
- **v1** : id `vm-inventory`, version 0.1.0. Route `/vms` → VmInventoryPage. Menu `nav.vmInventory` (icône MonitorSmartphone), order 40. Flag : `VITE_USE_PLUGIN_VM_INVENTORY` (défaut ON). `init()` : log uniquement.
- **v2** : id `vm-inventory_v2`, version 0.2.0 — même route/menu (même famille, §2.5 du skill `general`) + bouton « Console web ». Copie de la v1 ; seule différence fonctionnelle = le bouton console dans l'en-tête du panneau détail (`components/vm-detail.tsx`). La v1 reste intacte en rollback ; l'admin active la version à exposer (Administration → Versions).

## 2. Arborescence (5 fichiers)
| Fichier | Rôle |
|---|---|
| `pages/vm-inventory.tsx` | La page : données WS, tree + table + détail, sync URL (tree/q/status/type/vm) |
| `components/vm-tree.tsx` | Tree léger Tailwind (pas de dépendance) : Datacenter → endpoints → nœuds, compteurs en marche/total, expansion locale |
| `components/vm-table.tsx` | Filtres (statut/type + recherche nom/vmid) + table triable + stats |
| `components/vm-detail.tsx` | Panneau détail : fetch `/api/vm-config`, onglets Configuration / Réseau / Snapshots, barres d'utilisation |

## 3. Flux de données (deux sources)
- **Liste = live WS** : `useMulti()` → `snapshot.vms: VmSummary[]` par endpoint (push 5 s). `VmSummary` a été enrichi pour l'inventaire : `diskBytes`, `maxdiskBytes`, `cpuAllocCores`, `os`, `uptimeSec` (mapping poller depuis `cluster/resources` + jointure config — zéro appel API supplémentaire).
- **Détail = REST** : `fetchVmDetail(endpointId, vmid)` → `GET /api/vm-config?endpoint=&vmid=` → `VmDetailResponse { vm (live), config (cache 1 h), snapshots (appel PVE à la demande, cache 5 min) }`. La pseudo-entrée PVE `current` est filtrée côté serveur.
- Périmètre du tableau selon la sélection tree : `'dc'` = tout · `<epId>` = l'endpoint · `<epId>/<node>` = le nœud. Les VMs sont taggées `{ vm, endpointId }` (le détail a besoin de l'endpoint).

## 4. Fonctions pures (`@proxmox/shared/vm-inventory.ts`, 13 tests)
- `filterVmRows(vms, query, filter)` : recherche nom (contient, insensible à la casse) **ou vmid exact** + filtres nœud/statut/type.
- `sortVmRows(vms, key, dir)` : 8 clés (`name`, `vmid`, `node`, `type`, `status` [ordre running→paused→stopped→unknown], `cpuPct`, `memBytes`, `diskBytes`) ; **diskBytes null → fin de liste quel que soit le sens** (appliqué après le signe) ; dédoublonnage par vmid.
- `buildVmTree(rootLabel, endpoints, vmsByEndpoint)` : `VmTreeNode { id ('dc' | epId | 'epId/node'), kind, vmCount, runningCount, children? }`.

## 5. Conventions spécifiques
- **Sync URL** (deep-links) : `tree` (absent = 'dc') · `q` · `status` · `type` · `vm` (vmid détaillé). Le tri est en état local (non synchronisé).
- **i18n** : préfixe `vm.*` + `nav.vmInventory` (fr/en dans `@proxmox/shared/i18n`). Libellés VM/LXC du tableau non traduits (termes techniques).
- **Code couleur statuts** : running = ok (vert) · paused = warn (ambre) · stopped/unknown = default. Barres d'utilisation détail : <80 % primary, ≥80 % warn, ≥90 % crit.
- **Limite données connue** : PVE 9 renvoie `disk=0` dans `/cluster/resources` selon le stockage → « 0 o / X To » au tableau (pas de crash) ; le détail affiche la même valeur live.

## 6. Console web (v2)
- Bouton « Console web » dans l'en-tête du panneau détail : ouvre **la console de la VM dans l'UI PVE** (nouvel onglet, `window.open(..., 'noopener,noreferrer')`).
- URL : `${endpointUrl}/#next;nodes/<node>/<type>/<vmid>/console` — `endpointUrl` = `EndpointSnapshot.url` (URL API PVE, exposée par le poller + WS), `<type>` = `qemu` | `lxc`, `<node>`/`<vmid>` depuis le détail live.
- **Désactivé sans URL** (mode démo : mock sans `url`) — tooltip `vm.console.unavailable`. i18n : `vm.console.web` / `vm.console.unavailable`.
- Décision utilisateur : lien vers l'UI PVE, **pas de noVNC intégré**.

## 7. Hors périmètre
- Actions power (start/stop/reboot) — reportées (« plus tard »), token PVE écriture requis.
- Graphiques historiques par VM (RRD `vm_metrics` existe déjà côté serveur, à brancher en itération suivante).
- Création/migration/suppression de VM.
