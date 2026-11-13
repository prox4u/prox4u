---
name: vm-inventory
description: Base de connaissance du plugin Inventaire VM de Prox4u — page /vms : arborescence vCenter (Datacenter → cluster → nœud), tableau multi-endpoints filtrable/triable (VMs + LXC, live 5 s), panneau détail VM à onglets (Résumé / Monitor / Configuration / Réseau / Snapshots) via GET /api/vm-config, ET détail NŒUD plein écran (Résumé / Monitor / VMs — le Monitor nœud croise l'historique PVE /api/metrics?node= et les métriques agent hôte Telegraf : système, CPU par cœur, I/O disques par device). Lecture seule (pas d'actions power). Deux versions : v1 (id vm-inventory) et v2 (vm-inventory_v2, + bouton « Console web » vers l'UI PVE, + détail nœud). Use when working on the vm-inventory plugin (packages/web/src/plugins/vm-inventory/ ou vm-inventory_v2/), the /vms page, its components (vm-tree, vm-table, vm-detail, vm-monitor, node-detail, node-monitor), the node Monitor tab (system / per-core CPU / per-device disk I/O sections), or the /api/vm-config endpoint.
---

# Inventaire VM — Base de connaissance

Page `/vms` : **inventaire des VMs et conteneurs LXC** du parc multi-endpoints, présentation type vCenter — arborescence `Datacenter → cluster (endpoint) → nœud` à gauche, tableau filtrable au centre, panneau détail à onglets à droite au clic sur une ligne. **Lecture seule** : les tokens PVE sont en lecture seule (`ManagerReader`) ; les actions power (start/stop/reboot) sont une itération dédiée (token écriture + endpoints POST + UI de confirmation).

> Architecture globale : voir le skill `general`. Contrat API : skill `api` (`/api/vm-config`). Fonctions pures : skill `shared` (`vm-inventory.ts`).

## 1. Manifest (`index.ts`)
- **v1** : id `vm-inventory`, version 0.1.0. Route `/vms` → VmInventoryPage. Menu `nav.vmInventory` (icône MonitorSmartphone), order 40. Flag : `VITE_USE_PLUGIN_VM_INVENTORY` (défaut ON). `init()` : log uniquement.
- **v2** : id `vm-inventory_v2`, version 0.2.0 — même route/menu (même famille, §2.5 du skill `general`) + bouton « Console web ». Copie de la v1 ; seule différence fonctionnelle = le bouton console dans l'en-tête du panneau détail (`components/vm-detail.tsx`). La v1 reste intacte en rollback ; l'admin active la version à exposer (Administration → Versions).

## 2. Arborescence

**v1** (`vm-inventory/`) :

| Fichier | Rôle |
|---|---|
| `pages/vm-inventory.tsx` | La page : données WS, tree + table + détail, sync URL (tree/q/status/type/vm) |
| `components/vm-tree.tsx` | Tree léger Tailwind (pas de dépendance) : Datacenter → endpoints → nœuds, compteurs en marche/total, expansion locale |
| `components/vm-table.tsx` | Filtres (statut/type + recherche nom/vmid) + table triable + stats |
| `components/vm-detail.tsx` | Panneau détail : fetch `/api/vm-config`, onglets Configuration / Réseau / Snapshots, barres d'utilisation |

**v2** (`vm-view_v2/`) — approche vCenter, détails en **plein écran** (remplacent le tableau) :

| Fichier | Rôle |
|---|---|
| `pages/vm-view.tsx` | La page : tree avec **feuilles VM** (`ep/node/vmid`) ; clic **nœud** → page détail nœud ; clic VM → page détail VM ; sync URL (`tree`, `node`, `vm`) |
| `components/vm-tree.tsx` | Tree v1 + feuilles VM sous chaque nœud |
| `components/vm-table.tsx` | Table v1 + colonne « Agent PVE » (§6) |
| `components/vm-detail.tsx` | Détail VM plein écran : en-tête (état, console web) + onglets **Résumé / Monitor / Configuration / Réseau / Snapshots** |
| `components/vm-monitor.tsx` | Onglet Monitor VM (§8) |
| `components/node-detail.tsx` | Détail nœud plein écran : en-tête (en ligne/hors ligne, ratios de surallocation, uptime) + onglets **Résumé / Monitor / VMs** (§9) |
| `components/node-monitor.tsx` | Onglet Monitor nœud : historique PVE + sections agent hôte (§9) |
| `components/node-system-card.tsx` / `cpu-cores-card.tsx` / `node-diskio-card.tsx` | Sections agent hôte du Monitor nœud : Système (chips) / CPU par cœur (barres) / I/O disques par device (2 graphes) — détail skill `node-sensors` §2 |

## 3. Flux de données (deux sources)
- **Liste = live WS** : `useMulti()` → `snapshot.vms: VmSummary[]` par endpoint (push 5 s). `VmSummary` a été enrichi pour l'inventaire : `diskBytes`, `maxdiskBytes`, `cpuAllocCores`, `os`, `uptimeSec`, **`agentActive: boolean | null`** (état de l'agent invité QGA — mapping poller depuis le réchauffage agent existant, zéro appel API supplémentaire).
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

## 6. Colonne « Agent PVE » (v2)
- `components/vm-table.tsx` : **colonne « Agent PVE »** (`agentActive`) insérée après l'état, **triable** (clé `agentActive`). Rendu : `null` → « — » · `true` → badge vert « actif » · `false` → **badge rouge « inactif »** (critique). `colSpan` du tableau passé de 8 à 9.
- **Tri** (fonction pure shared `sortVmRows`, clé `agentActive`) : **inactif (`false`, critique) d'abord en asc** · `null` **toujours en fin de liste** quel que soit le sens (même règle « nulls last » que `diskBytes`).
- i18n : `vm.col.agent` / `vm.agent.active` / `vm.agent.down`.
- Sémantique `agentActive` : voir skill `proxmox-inventory` §7 (`true` = QGA répond · `false` = VM en cours sans agent, critique · `null` = n/a ou inconnu).

## 7. Console web (v2)
- Bouton « Console web » dans l'en-tête du panneau détail : ouvre **la console de la VM dans l'UI PVE** (nouvel onglet, `window.open(..., 'noopener,noreferrer')`).
- URL : `${endpointUrl}/#next;nodes/<node>/<type>/<vmid>/console` — `endpointUrl` = `EndpointSnapshot.url` (URL API PVE, exposée par le poller + WS), `<type>` = `qemu` | `lxc`, `<node>`/`<vmid>` depuis le détail live.
- **Désactivé sans URL** (mode démo : mock sans `url`) — tooltip `vm.console.unavailable`. i18n : `vm.console.web` / `vm.console.unavailable`.
- Décision utilisateur : lien vers l'UI PVE, **pas de noVNC intégré**.

## 8. Onglet Monitor (v2) — historiques par VM
- `components/vm-monitor.tsx` : graphiques historiques depuis InfluxDB, timeframes 1 h / 24 h / 7 j / 30 j, auto-refresh 60 s, export CSV du timeframe affiché (général + par graphe).
- **Deux mesures** : `vm_metrics` (CPU/RAM/I/O/réseau — `/api/vm-metrics`) et `vm_fs` (**occupation disque PAR FILESYSTEM** — `/api/vm-fs`).
- **Occupation disque par partition** : un **graphe par filesystem** (point de montage + périphérique, ex. `/` sur `sda1`, `/NFS` sur `sda6`) — espace utilisé (courbe ambrée) + taille du fs (ligne pointillée indigo), **légende** `Utilisé`/`Alloué`. Source : agent invité QEMU `get-fsinfo` (fs sur disque VM, `disk` non vide — les vrais montages réseau sont exclus) ; LXC = un seul rootfs (`disk`/`maxdisk` de `/cluster/resources`). Le poller interroge l'agent **au plus toutes les 5 min** par VM (throttle) et écrit `vm_fs` (une série par mountpoint) + l'agrégat `disk_bytes`/`disk_alloc_bytes` dans `vm_metrics`.
- **Privilège PVE** : `VM.GuestAgent.Audit` suffit (pas `Unrestricted`). Contrainte PVE 9.1.1 : seuls `agent/get-fsinfo` fonctionne (`agent/fs-info` « not implemented », `agent/exec` HTTP 596) — voir skill `operations` + `deploiement/DEPLOY.md` §2.
- `maxmemBytes`/`maxdiskBytes` (du détail live) alimentent les lignes d'allocation RAM / le pied de page d'allocation totale.

## 9. Détail nœud + Monitor nœud (v2)
- `components/node-detail.tsx` : un **nœud est sélectionnable dans l'arbre comme une VM** — sa page détail plein écran remplace le tableau. En-tête : état (● en ligne / hors ligne), badges ratios de surallocation CPU/RAM, IP + uptime. Onglets **Résumé** (4 cartes KPI : CPU/RAM/rootfs/charge moyenne — mêmes KPIs PVE live que la vue nœud hypervision) / **Monitor** / **VMs** (`VmTable` filtrée sur le nœud, clic → détail VM). Montage **lazy** du Monitor (ses requêtes n'existent que quand l'onglet est ouvert).
- `components/node-monitor.tsx` — même expérience que le Monitor VM (1 graphe par ligne pleine largeur, timeframes 1h/24h/7j/30j, auto-refresh 60 s, export CSV général + par graphe), **deux sources indépendantes** :
  - **PVE** : `fetchMetrics(tf, endpointId, node)` → `/api/metrics?node=` (`node_metrics`) → 4 graphes CPU / RAM / Disque rootfs / Réseau. Pas de série (nœud trop récent, hors ligne, InfluxDB KO) → message `vm.node.insufficient` à la place des graphes.
  - **Agent hôte (Telegraf 10 s)** — même source que la carte « Système » de la Vue d'ensemble (skill `node-sensors` §3.3) :
    - `NodeSystemCard` (tête d'onglet) : chips du nœud affiché — load 1/5/15 teinté vs cœurs (≥1 warn, ≥2 crit), cœurs, iowait (≥10/≥25), swap (≥50/≥80), uptime.
    - `CpuCoresCard` (après le graphe CPU) : usage **courant** par cœur (barres <70 ok/<90 warn/≥90 crit, tooltip user/system/iowait), hauteur dynamique (≥240 px sinon 18 px/cœur), CSV.
    - `NodeDiskioCard` (après le graphe rootfs) : I/O **par device physique** — 2 graphes (débits lecture=plein/écriture=pointillé ; busy % + IOPS), **timeframe piloté par la barre d'outils de l'onglet** (pas de switcher local), CSV.
  - **Indépendance des sources** : si la série PVE est vide, les sections Telegraf restent montées (états vides propres — nœud sans agent) et inversement ; le fetch `/api/node-system` (cache 60 s) est fait une seule fois par montage, la ligne du nœud affiché est recherchée par nom.
- i18n : `vm.node.system` / `vm.node.system.hint` (nouvelles) ; les sections graphiques réutilisent les libellés `overview.diskio.*` / `overview.cpubars.*` (une seule source de wording — ne pas dupliquer).
- **Historique** : les 2 sections I/O + CPU par cœur ont été livrées d'abord dans la Vue d'ensemble (2026-11-13, `LAYOUT_VERSION` 3) puis **déplacées ici** à la demande (Vue d'ensemble = parc → ne garde que la carte Système cross-node ; par-device/par-cœur = drill-down d'un nœud) — `LAYOUT_VERSION` 4, composants déplacés de `plugins/hypervision/components/` → `plugins/vm-view_v2/components/`.

## 10. Hors périmètre
- Actions power (start/stop/reboot) — reportées (« plus tard »), token PVE écriture requis.
- Création/migration/suppression de VM.
