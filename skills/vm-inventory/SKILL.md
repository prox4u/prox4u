---
name: vm-inventory
description: Base de connaissance du plugin Inventaire VM de Prox4u — page /vms : arborescence vCenter (Datacenter → cluster → nœud), tableau multi-endpoints filtrable/triable (VMs + LXC, live 5 s), panneau détail VM à onglets (Résumé / Monitor / Configuration / Réseau / Snapshots) via GET /api/vm-config, ET détail NŒUD plein écran (Résumé / Monitor / VMs — le Monitor nœud croise l'historique PVE /api/metrics?node= et les métriques agent hôte Telegraf : système, CPU par cœur, I/O disques par device, réseau par interface — et le Monitor VM ajoute I/O par disque de la VM + réseau par carte). Lecture seule (pas d'actions power). Quatre versions : v1 (id vm-view), v2 (vm-view_v2, + bouton « Console web » vers l'UI PVE, + détail nœud), v3 (vm-view_v3, + monitors VM/nœud en grilles personnalisables par user — drag/resize/bibliothèque, persistance /api/user-config par VM et par nœud) et v4 (vm-view_v4, + 6 widgets Monitor nœud : températures chips/disques SMART, santé SMART, ZFS ARC, charge moyenne, swap + section « Capacité du cluster » du détail VM (onglet Résumé) — 3 graphiques capacity planning par élément au niveau cluster, réemploi cross-plugin de CapacityChartBody hypervision_v4). Use when working on the vm-view plugin family (packages/web/src/plugins/vm-view/, vm-view_v2/, vm-view_v3/ ou vm-view_v4/), the /vms page, its components (vm-tree, vm-table, vm-detail, vm-monitor, node-detail, node-monitor), the node Monitor tab (system / per-core CPU / per-device disk I/O / temps / ZFS ARC / load / swap sections), or the /api/vm-config endpoint.
---

# Inventaire VM — Base de connaissance

Page `/vms` : **inventaire des VMs et conteneurs LXC** du parc multi-endpoints, présentation type vCenter — arborescence `Datacenter → cluster (endpoint) → nœud` à gauche, tableau filtrable au centre, panneau détail à onglets à droite au clic sur une ligne. **Lecture seule** : les tokens PVE sont en lecture seule (`ManagerReader`) ; les actions power (start/stop/reboot) sont une itération dédiée (token écriture + endpoints POST + UI de confirmation).

> Architecture globale : voir le skill `general`. Contrat API : skill `api` (`/api/vm-config`). Fonctions pures : skill `shared` (`vm-inventory.ts`).

## 1. Manifest (`index.ts`)
- **v1** : id `vm-view`, version 0.1.0. Route `/vms` → VmViewPage. Menu `nav.vmView` (icône MonitorSmartphone), order 40. Flag : `VITE_USE_PLUGIN_VM_VIEW` (défaut ON). `init()` : log uniquement. (La famille s'appelait `vm-inventory` à l'origine — le skill porte encore ce nom ; l'id, les dossiers et le module shared sont `vm-view`.)
- **v2** : id `vm-view_v2`, version 0.2.0 — même route/menu (même famille, §2.5 du skill `general`) + bouton « Console web » + détail nœud. Copie de la v1 ; différences fonctionnelles = le bouton console dans l'en-tête du panneau détail (`components/vm-detail.tsx`) + les pages détail plein écran (§9). La v1 reste intacte en rollback ; l'admin active la version à exposer (Administration → Versions).
- **v3** : id `vm-view_v3`, version 0.3.0 — même périmètre que la v2 + **monitors VM et nœud en grilles personnalisables par user** (§10). Copie de la v2 ; seules différences = `components/vm-monitor.tsx` et `components/node-monitor.tsx` convertis en `WidgetGridLayout`. La v2 reste en rollback (`/vms?v=vm-view_v2`).
- **v4** : id `vm-view_v4`, version 0.4.0 — même périmètre que la v3 + **bibliothèque du Monitor nœud complétée** : 6 nouveaux widgets (températures chips, températures disques SMART, santé disques, ZFS ARC, charge moyenne, swap — référence ProxMenux, §11). Copie de la v3 ; seule différence = `components/node-monitor.tsx`. La v3 reste en rollback (`/vms?v=vm-view_v3`).

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
| `components/vm-monitor.tsx` | Onglet Monitor VM (§8) — dont sections agent hôte « Disques I/O — par device » et « Réseau — par interface » (1 carte par disque / par NIC) |
| `components/node-detail.tsx` | Détail nœud plein écran : en-tête (en ligne/hors ligne, ratios de surallocation, uptime) + onglets **Résumé / Monitor / VMs** (§9) |
| `components/node-monitor.tsx` | Onglet Monitor nœud : historique PVE + sections agent hôte (§9) |
| `components/node-system-card.tsx` / `cpu-cores-card.tsx` / `node-diskio-card.tsx` / `node-net-card.tsx` | Sections agent hôte du Monitor nœud : Système (chips) / CPU par cœur (barres) / I/O disques par device (2 graphes) / Réseau **par interface** (1 carte graphique PAR INTERFACE DU NŒUD — même liste que la page Réseau de Proxmox : titre = nom PVE + badge type/actif, joint des mesures sur `kernels`, état vide par carte ; interfaces pare-feu PVE `fw*` **décryptées** (badge « pare-feu PVE · machine 102 · net0 · pont (fwbr) », infobulle = trajet paquet, bloc dépliable `FwDecodeBlock` si des fw* existent) — détail skill `node-sensors` §2/§4/§6 |

**v3** (`vm-view_v3/`) : copie de la v2, mêmes 12 fichiers — seules différences : `components/vm-monitor.tsx` et `components/node-monitor.tsx` convertis en grilles personnalisables (§10) + `index.ts` (manifest v3). Les corps de carte (contenu sans `Card`/en-tête — c'est la `WidgetFrame` du socle qui fournit l'en-tête) : `CpuCoresBody` (`cpu-cores-card.tsx`), `NodeSystemStatsGrid` (`node-system-card.tsx`), `FwDecodeBlock` (`node-net-card.tsx`), et corps locaux dans les monitors (`StaticChartBody`, `FsUsageBody`, `PerDeviceBody`, `PerIfaceBody` dans vm-monitor ; `StaticChartBody`, `NodeDiskioBody`, `NodeNetIfaceBody` dans node-monitor) — le corps remplit la cellule (`min-h` + `flex-1`, ECharts ResizeObserver).

## 3. Flux de données (deux sources)
- **Liste = live WS** : `useMulti()` → `snapshot.vms: VmSummary[]` par endpoint (push 5 s). `VmSummary` a été enrichi pour l'inventaire : `diskBytes`, `maxdiskBytes`, `cpuAllocCores`, `os`, `uptimeSec`, **`agentActive: boolean | null`** (état de l'agent invité QGA — mapping poller depuis le réchauffage agent existant, zéro appel API supplémentaire).
- **Détail = REST** : `fetchVmDetail(endpointId, vmid)` → `GET /api/vm-config?endpoint=&vmid=` → `VmDetailResponse { vm (live), config (cache 1 h), snapshots (appel PVE à la demande, cache 5 min) }`. La pseudo-entrée PVE `current` est filtrée côté serveur.
- Périmètre du tableau selon la sélection tree : `'dc'` = tout · `<epId>` = l'endpoint · `<epId>/<node>` = le nœud. Les VMs sont taggées `{ vm, endpointId }` (le détail a besoin de l'endpoint).

## 4. Fonctions pures (`@proxmox/shared/vm-view.ts`, 13 tests)
- `filterVmRows(vms, query, filter)` : recherche nom (contient, insensible à la casse) **ou vmid exact** + filtres nœud/statut/type.
- `sortVmRows(vms, key, dir)` : 8 clés (`name`, `vmid`, `node`, `type`, `status` [ordre running→paused→stopped→unknown], `cpuPct`, `memBytes`, `diskBytes`) ; **diskBytes null → fin de liste quel que soit le sens** (appliqué après le signe) ; dédoublonnage par vmid.
- `buildVmTree(rootLabel, endpoints, vmsByEndpoint)` : `VmTreeNode { id ('dc' | epId | 'epId/node'), kind, vmCount, runningCount, children? }`.

## 5. Conventions spécifiques
- **Sync URL** (deep-links) : `tree` (absent = 'dc') · `q` · `status` · `type` · `vm` (vmid détaillé). Le tri est en état local (non synchronisé).
- **i18n** : préfixe `vm.*` + `nav.vmView` (fr/en dans `@proxmox/shared/i18n`). Libellés VM/LXC du tableau non traduits (termes techniques).
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
- **Sections agent hôte (source indépendante PVE)** — mêmes patterns que le Monitor nœud (skill `node-sensors` §3.3/§6) :
  - `PerDeviceDiskSection` (après le graphe disque agrégat) : I/O **par disque de la VM** (`/api/vm-diskio`, mapping dm-N → LV).
  - `PerIfaceNetSection` (après le graphe Réseau agrégé) : trafic **par carte de la VM** (`/api/vm-net`) — **UN GRAPHIQUE PAR NIC** (net0 (vmbr0), net1 (nfs)…) RX=plein/TX=pointillé, source = device tap hôte joint à la config PVE **par MAC** (l'API PVE n'expose que l'agrégat). Échec du fetch **isolé** (`.catch` → null, comme vm-diskio) ; états lisibles : `noMapping` (agent à (re)déployer), `noMac` (carte sans tap : VM arrêtée/SDN — points vides, jamais de valeur inventée).

## 9. Détail nœud + Monitor nœud (v2)
- `components/node-detail.tsx` : un **nœud est sélectionnable dans l'arbre comme une VM** — sa page détail plein écran remplace le tableau. En-tête : état (● en ligne / hors ligne), badges ratios de surallocation CPU/RAM, IP + uptime. Onglets **Résumé** (4 cartes KPI : CPU/RAM/rootfs/charge moyenne — mêmes KPIs PVE live que la vue nœud hypervision) / **Monitor** / **VMs** (`VmTable` filtrée sur le nœud, clic → détail VM). Montage **lazy** du Monitor (ses requêtes n'existent que quand l'onglet est ouvert).
- `components/node-monitor.tsx` — même expérience que le Monitor VM (1 graphe par ligne pleine largeur, timeframes 1h/24h/7j/30j, auto-refresh 60 s, export CSV général + par graphe), **deux sources indépendantes** :
  - **PVE** : `fetchMetrics(tf, endpointId, node)` → `/api/metrics?node=` (`node_metrics`) → 4 graphes CPU / RAM / Disque rootfs / Réseau. Pas de série (nœud trop récent, hors ligne, InfluxDB KO) → message `vm.node.insufficient` à la place des graphes.
  - **Agent hôte (Telegraf 10 s)** — même source que la carte « Système » de la Vue d'ensemble (skill `node-sensors` §3.3) :
    - `NodeSystemCard` (tête d'onglet) : chips du nœud affiché — load 1/5/15 teinté vs cœurs (≥1 warn, ≥2 crit), cœurs, iowait (≥10/≥25), swap (≥50/≥80), uptime.
    - `CpuCoresCard` (après le graphe CPU) : usage **courant** par cœur (barres <70 ok/<90 warn/≥90 crit, tooltip user/system/iowait), hauteur dynamique (≥240 px sinon 18 px/cœur), CSV.
    - `NodeDiskioCard` (après le graphe rootfs) : I/O **par device physique** — 2 graphes (débits lecture=plein/écriture=pointillé ; busy % + IOPS), **timeframe piloté par la barre d'outils de l'onglet** (pas de switcher local), CSV.
     - `NodeNetCard` (après le graphe Réseau agrégé) : **UN GRAPHIQUE PAR INTERFACE HÔTE** (NICs physiques + ponts vmbr* ; **vnet\*/tap\*/veth\*/lo exclus** — leur trafic est dans le Monitor de chaque VM, double-comptage sinon) — RX=plein/TX=pointillé, même timeframe d'onglet, CSV (t, iface, in_bps, out_bps).
  - **Indépendance des sources** : si la série PVE est vide, les sections Telegraf restent montées (états vides propres — nœud sans agent) et inversement ; le fetch `/api/node-system` (cache 60 s) est fait une seule fois par montage, la ligne du nœud affiché est recherchée par nom.
- i18n : `vm.node.system` / `vm.node.system.hint` (nouvelles) ; les sections graphiques réutilisent les libellés `overview.diskio.*` / `overview.cpubars.*` / `overview.netif.*` (une seule source de wording — ne pas dupliquer) ; Monitor VM : `vm.mon.perDevice.*` / `vm.mon.netPerIface.*`.
- **Historique** : les 2 sections I/O + CPU par cœur ont été livrées d'abord dans la Vue d'ensemble (2026-11-13, `LAYOUT_VERSION` 3) puis **déplacées ici** à la demande (Vue d'ensemble = parc → ne garde que la carte Système cross-node ; par-device/par-cœur = drill-down d'un nœud) — `LAYOUT_VERSION` 4, composants déplacés de `plugins/hypervision/components/` → `plugins/vm-view_v2/components/`.

## 10. `vm-view_v3` (v0.3.0) — Monitors VM & nœud personnalisables par user

Même périmètre que la v2 (tree/tableau/détails/console web inchangés — §3 à §9 s'appliquent) ; seules les pages **Monitor** de la VM et du nœud deviennent des grilles `WidgetGridLayout` (socle `core/widgets` — skill `general` §12, piège RGL v2 §10) : drag/resize des cartes, retrait → **bibliothèque** de la page (réinsérable), **Réinitialiser** avec confirmation. Persistance par compte via `GET/PUT/DELETE /api/user-config` — **un layout par VM et par nœud**.

- **Monitor VM** (`components/vm-monitor.tsx`) — scope **`vmView « <endpointId>/<vmid> »`** (le vmid est stable : données fetchées par vmid, sous-titres par nom) :
  - Catalogue : `cpu` (`vm.mon.cpu`) / `mem` (`vm.mon.mem`) / `disk` (`metrics.disk`) / `net` (`vm.mon.net`) — `StaticChartBody` ; **dynamiques** `diskio-<device>` (`vm.mon.perDevice`) — `PerDeviceBody`, `fs-<mountpoint>` (`vm.mon.diskUsage`) — `FsUsageBody`, `net-<iface>` (`vm.mon.netPerIface`) — `PerIfaceBody`.
  - **Sous-titre = nom de la VM** sur chaque carte (`WidgetFrame`, via `ctx.vmName`).
  - **Export CSV conservé par carte** (button dans le slot `extra` de la frame) — même contenu que l'export v2.
  - **Gate `ready`** : la grille ne se monte qu'après le 1ᵉʳ chargement (`ready = !!(data || fsData || diskioData || netData)`) ; pendant les refresh 60 s les **données en cours sont gardées** → les ids dynamiques du catalogue restent stables (pas de remontage, pas de drag interrompu). Layout par défaut = `defaultStackLayout` (pile pleine largeur, comme la v2).
- **Monitor nœud** (`components/node-monitor.tsx`) — scope **`nodeView « <endpointId>/<nomDuNœud> »`** (⚠️ un **renommage de nœud remet le layout à zéro** — accepté, documenté) :
  - Catalogue : `system` (`vm.node.system`, w12 h2) — `NodeSystemStatsGrid` ; `cpu` (`metrics.cpu`) / `ram` (`metrics.ram`) / `rootfs` (`node.kpi.rootfs`) / `net` (`vm.mon.net`) — `StaticChartBody` ; `cpubars` (`overview.cpubars`) — `CpuCoresBody` ; `diskio` (`overview.diskio`, w12 h6) — `NodeDiskioBody` ; **dynamiques** `netif-<iface>` (titre = nom PVE de l'interface) — `NodeNetIfaceBody` (décryptage fw* via `FwDecodeBlock`).
  - **Sous-titre = nom du nœud** sur chaque carte (`ctx.nodeName`).
  - Gate `ready = netDone` (1ᵉʳ chargement terminé).
- **Sources de données = celles de la v2, inchangées** (§8 : `vm_metrics`/`vm_fs`/`/api/vm-diskio`/`/api/vm-net` ; §9 : `/api/metrics?node=` + `/api/node-system` + réseau par interface) — seul le conteneur change (grille au lieu de pile de cartes).
- **Validation livrée** : Playwright stage 2 (26 assertions) — deep-links `?vm=100` / `?node=proxmox%2Fproxmox`, sous-titres VM/nœud 4/4, drag → scope `vmView`/`nodeView` persistés, widgets dynamiques (20 cartes sur le nœud de test), persistance au retour.

## 11. `vm-view_v4` (v0.4.0) — Bibliothèque du Monitor nœud complétée (référence ProxMenux)

Même périmètre que la v3 (§3 à §10 s'appliquent) ; seul **`components/node-monitor.tsx`** change :
**6 nouveaux widgets** dans le catalogue (tous w12 h4, minH 3, sous-titre = nom du nœud, export
CSV dans le slot `extra`) — port des graphiques manquants du dashboard ProxMenux, alimentés par
**4 nouveaux endpoints serveur** (skill `node-sensors` §5) + le live existant `/api/node-sensors` :

| id | Widget | Source | Corps |
|---|---|---|---|
| `temp-cpu` | Températures CPU & chips | `/api/node-temps` | `HostTempsBody` — une courbe par chip |
| `smart-temps` | Températures disques (SMART) | `/api/smart-temps` | `SmartTempsBody` — une courbe par disque + modèle dans la légende, `markLine` seuil critique 80 °C |
| `smart-health` | Santé disques (SMART) | `/api/node-sensors` (live) | `SmartHealthBody` — **table** (pas de graphe) : badge tri-state, temp (0 °C → « — »), usure NVMe % / secteurs (rouge si > 0), heures |
| `zfs-arc` | ZFS ARC | `/api/zfs-arc` | `ZfsArcBody` — GiB (aire) + `markLine` ARC max + hit rate % axe droit **masquée si compteurs 0** |
| `load` | Charge moyenne | `/api/node-system-history` | `LoadBody` — load 1/5/15 + rappel « Cœurs : N » |
| `swap` | Swap | `/api/node-system-history` | `SwapBody` — utilisé (octets) + % axe droit ; état « Pas de swap configuré » si total = 0 |

- **Hooks hoistés** (pattern `useNodeDiskio` — state + tick `REFRESH_MS` 60 s + effet sur
  `[node, timeframe, tick]`) : `useNodeTemps`, `useSmartTemps`, `useZfsArc`, `useNodeHostHistory`
  (un seul fetch pour load + swap), `useNodeSensorsLive` (sans timeframe — état courant, pour
  `smart-health`). `load` et `swap` partagent `hostHistData` (2 widgets, 1 requête).
- **`multiLineOption(ct, tf, times, series, opts)`** — helper local générique de graphe
  multi-séries (axe gauche format libre + axe droit % optionnel pour `yAxisIndex: 1` +
  `markLine` de référence portée par la 1re série + `tooltipFormatter` custom multi-unités) ;
  `multiPalette` (6 couleurs : `ct.temp/cpu/ram/disk/netIn/netOut`) + `fmtTempTooltip`.
- **Ordre catalogue** : après `net`, **avant** les `netif-*` dynamiques (les ids dynamiques
  doivent rester à la fin pour la stabilité du gate `ready`).
- **Layouts** : scopes user-config **inchangés** (`nodeView « <endpointId>/<nomDuNœud> »`) →
  v3↔v4 **partagent les layouts** ; les 6 nouveaux widgets sont ajoutés **en bas par le merge**
  (nouvelle version du code = nouveaux ids dans le catalogue ; `defaultStackLayout` les inclut
  pour les utilisateurs sans layout sauvegardé). Piège `mergePageConfig(null, …)` : l'ajout des
  widgets manquants ne s'exécute qu'avec un layout **déjà sauvegardé** — ici sans conséquence
  car le default layout du Monitor nœud est **dérivé du catalogue** (contrairement à la Vue
  d'ensemble, skill `hypervision` §10).
- **Exports CSV** : `exportNodeTempsCsv` / `exportSmartTempsCsv` / `exportZfsArcCsv` /
  `exportHostHistoryCsv(data, node, tf, 'load' | 'swap')` (scope = colonnes) /
  `exportSmartHealthCsv` (état courant, une ligne par disque).
- **i18n** : `vm.node.{temps,smartTemps,zfsArc,load,swap}.*` (titres, hints, états vides,
  `load.l1/l5/l15`, `swap.used/pct/noSwap`, `smartHealth.{sectors,reallocated,pending,uncorrectable}`)
  — le widget santé réutilise `nodeSensors.{smart,noSmart,healthy,unhealthy,unknown,wear}` et
  `overview.system.cores`.
- **Réemploi cross-plugin par `hypervision_v4`** : la page nœud unifiée de `hypervision_v4`
  (skill `hypervision` §11) **importe statiquement** de `node-monitor.tsx` 28 exports
  (`TIMEFRAMES`, `ALL_COLS`, 7 hooks `useNode*`, 9 exports CSV, 10 corps `*Body`) +
  `CpuCoresBody` (`cpu-cores-card.tsx`) + `FwDecodeBlock` (`node-net-card.tsx`) pour réutiliser
  les mêmes graphiques du Monitor nœud dans sa grille. **Piège versionnement** : ces corps sont
  la source de vérité partagée — un fix futur de l'un d'eux exige **vm-view_v5 + hypervision_v5**
  (les deux plugins importent le même fichier v4). L'import est statique (bundlé) → fonctionne
  quel que soit l'état du plugin vm-view (pas de `dependencies` dans le manifest hypervision_v4).
- **Hors périmètre (ProxMenux)** : latence réseau (plugin Telegraf `ping` — `CAP_NET_RAW`) et
  GPU (plugin `nvidia-smi` absent) — données non collectées.
- **Validation livrée** : Playwright 34/34 — 6 widgets rendus avec données réelles (CSV exportés
  et parsés : 8 chips, 3 disques + modèles, hit rate vide, `n_cpus`=24, swap total constant),
  A/B v3 (6/6 absents) + v2 (statique), test-user (6/6 visibles).
- **Détail VM — section « Capacité du cluster » (onglet Résumé)** : `vm-detail.tsx` affiche,
  sous les panneaux vSphere du Résumé, une section pleine largeur « Capacité du cluster » avec
  **3 `CapacityChartBody`** (un par élément, prop `metric` — skill `hypervision` §11.8) en grille
  `md:grid-cols-3`. Données : capacity planning **au niveau cluster** de l'endpoint qui héberge
  la VM (pas l'usage propre de la VM) — `fetchCapacity(endpointId)` (`/api/capacity?endpoint=`)
  avec **cache module** (`capacityCache` Map, `CAPACITY_TTL_MS` 5 min) via le hook
  `useClusterCapacity` → pas de re-fetch en changeant de VM (capacity identique pour toutes les
  VMs de l'endpoint). **Import cross-plugin** : `vm-detail.tsx` importe `CapacityChartBody`
  **statiquement** depuis `../../hypervision_v4/components/capacity-chart` — nouvelle direction
  d'import (l'existant était hypervision_v4 → vm-view_v4), **pas de cycle de modules** (modules
  distincts), bundlé au build. i18n : `vm.sum.capacity{,.hint}`.

## 12. Hors périmètre
- Actions power (start/stop/reboot) — reportées (« plus tard »), token PVE écriture requis.
- Création/migration/suppression de VM.
