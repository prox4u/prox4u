---
name: storage
description: Base de connaissance du plugin Storage de Prox4u — page /storage : inventaire vCenter des datastores (capacité, type, contenus, VMs hébergées), drill-down VMs, recherche, tri, export CSV, vue multi-endpoints. Use when working on the storage plugin (packages/web/src/plugins/storage/), the /storage page, the datastore table (storage-inventory.tsx), or any storage hypervision feature.
---

# Storage — Base de connaissance

Page `/storage` : **inventaire vCenter** des datastores — une ligne par datastore (barre de capacité, icône de type, nœud/partagé, contenus, VMs hébergées), dépliable vers les VMs dont le disque est sur ce datastore. Migrated from legacy (Strangler Fig, étape 4).

> Architecture globale : voir le skill `general`.

## 1. Manifest (`index.ts`)
- id `storage`, version 0.1.0. Route `/storage` → StoragePage. Menu `nav.storage` (icône HardDrive), order 30. `init()` : log uniquement.

## 2. Arborescence (4 fichiers)
| Fichier | Rôle |
|---|---|
| `pages/storage.tsx` | La page : fetch, sync URL (view/q/type), états loading/error, bouton Actualiser. Rend le panneau volumes (`StorageVolumes`) **au-dessus** de la table. |
| `components/storage-inventory.tsx` | Table des datastores (~520 lignes) en **hiérarchie iSCSI → LVM** + helpers internes `CapacityBar`, `SortHead`, `TopRow`, `RowCells`, `VmDrilldown` |
| `components/storage-volumes.tsx` | **Panneau « Volumes physiques »** (arbre iSCSI → LVM) : carte LUN parent + VG enfants indentés, borne basse LUN, thin/thick, ratio/usage |

## 3. StoragePage — état et sync URL
- Données : `fetchStorageInventory()` au montage + bouton Actualiser (cache serveur 5 min).
- **Sync URL (deep-links partageables)** : `view` ('all' = vue agrégée, sinon id d'endpoint) · `q` (recherche) · `type` (type de datastore ; effacé quand la vue change).
- Noms d'endpoints issus du store WS (`useMulti()`).

## 4. StorageInventory — table vCenter
- **Colonnes** : datastore (icône par type) · serveur (vue agrégée uniquement) · type (badge, primary si partagé) · nœud (ou « partagé ») · capacité (barre + utilisé/total) · contenus · VMs (running+stopped) · état (badge sévérité).
- **CapacityBar** : fond = total, remplissage = utilisé, teinte = sévérité (`storageSeverity(row, config)` d'après overcommit.json) ; `na` → barre vide + « — ».
- **Tri** (`SortHead`) : datastore, serveur, type, capacité, vms, état — premier clic sur capacité/vms/état = décroissant.
- **Déroulé de type** : types présents dans la vue courante uniquement (dédoublonnés).
- **Hiérarchie iSCSI → LVM** : un LUN iSCSI (sans `parentStorage`) est un **parent dépliable** ; ses VG enfants (`parentStorage` = nom du LUN) sont rendus **indentés** sous lui (libellé « · sous {LUN} », **cellule Serveur vide** — le serveur est déjà montré par le parent, pas de doublon). Déplier le LUN révèle ses VG ; déplier un VG (ou un datastore autonome) révèle ses VMs. Recherche/filtre de type : un groupe est visible si le LUN **ou** l'un de ses VG correspond (`groupMatches`).
- **Drill-down** (`TopRow` → `RowCells` + `VmDrilldown`) : dépliage → graphe **Occupation** (série `datastore_metrics`, voir §7 `skills/general`) + VMs du datastore (nom, vmid, taille disque, nœud, état) ; pagination `VM_PAGE = 50` + « Afficher plus » (garde-fou prod). **Règle `expandable`** : une ligne est dépliable si elle a des **VG enfants** OU des **VMs** OU une **capacité connue** (`hasCapacity`) — un datastore « local » sans VM (dir ISOs/backups) a bel et bien un graphique Occupation, il doit pouvoir s'ouvrir dessus (même règle sur les VG enfants). Sans capacité connue → pas de série possible → ligne non dépliable.
- **Export CSV** : inventaire plat — une ligne par VM sur un datastore (`serveur,datastore,type,nature,noeud,vmid,vm,noeud_vm,disque_octets,etat`), BOM `\ufeff` pour Excel, échappement soigné.

## 4B. StorageVolumes — panneau « Volumes physiques » (arbre iSCSI → LVM)
- **But** : montrer le stockage **en hiérarchie iSCSI → LVM**, pas par datastore. Un **LUN iSCSI est le volume physique de référence (parent)** ; les **VG LVM qui reposent dessus en sont les enfants** (un LUN peut porter **plusieurs VG** — vrai matériel). La capacité du LUN est comptée **une seule fois** (jamais LUN + VG). C'est la « analyse intelligente » demandée.
- **Données** : **lus du snapshot WS** (`multi.endpoints[].snapshot.storageVolumes`), calculés par le **poller** via la fonction pure shared **`buildStorageVolumes(storages, alloc, config, lunSizes?)`** — **source unique** (le poller applique la config de taille LUN `storage-volumes.json`, inconnue côté client). Zéro recalcul client. La **comptée VM par volume** est enrichie depuis l'inventaire (`endpoints[].vms[].diskBytes`) : un LUN compte l'**union** des VMs de tous ses VG enfants.
- **Sémantique « utilisé » d'un LUN** : **Σ tailles des VG enfants (espace engagé/réservé)**, PAS les données des VG. Ex. LUN 600 Go / VG 100 Go → 100 Go engagés, 500 Go libres. Chaque VG enfant affiche ses propres données/taille.
- **Capacité du LUN (`totalSource`)** : `'lun'` = taille du LUN connue (config `lunSizes`, valeur d'autorité) · `'vg-sum'` = **somme des tailles des VG = borne basse** (le LUN peut être plus grand — le panneau l'affiche, libellé « Capacité (borne basse) » + note). Jamais la somme LUN + VG.
- **Classification** : `thinCapable` (lvmthin/zfs/rbd) → **sur-allocation** (peut >1, `overcommitTone`) ; thick (dir/lvm/nfs/iscsi/cifs) → **usage** (≤1, `usageSeverity`). Volume sans disque → `kind=na`, `tone=na`.
- **Rendu (arbre)** : carte du LUN (parent) + **VG enfants indentés** (bordure gauche en pointillés, connecteur **« └ »** + libellé **« · sous {LUN} »** pour montrer l'appartenance, icône disque, libellé « Capacité du VG »). **Repli** : le LUN parent porte un chevron (« Replier/Déplier le LUN ») qui masque/révèle ses VG enfants (déplié par défaut ; état local `collapsedKeys`, clé `endpointId/storage`). Pied du LUN : nb VMs (union) + **liste des VG** (ex. « 1 VG : Lun-iscsi ») — visible même replié. Un volume sans enfant est une carte seule.
- **Vue** : respecte le `view` de la page (vue agrégée = volumes de tous les endpoints avec label serveur ; vue endpoint = seulement ses volumes). Trier par alloué décroissant.
- **i18n** : `storage.volumes.*` (title, hint, thin, thick, capacity, **capacityLower, vgCapacity, committed, lunNote, lunNoteHelp, vgChildren, vgChildrenHelp**, allocated, overcommit, usage, na, vms).

## 5. Données consommées
- REST : `fetchStorageInventory()` → `/api/storage-inventory` (cache serveur 5 min) · `fetchStorageDatastoreHistory(endpointId, 'year'|'month')` → `/api/storage-datastore-history` — séries d'occupation par datastore (`datastore_metrics` InfluxDB, repli RRD si < 7 j) + prévision de saturation (jours avant 80/90 %, pente, projection 30 j) ; alimente le **graphe Occupation** du drill-down.
- Fonctions pures shared : `buildStorageInventory(storages, vms)`, `buildStorageInventoryAll(endpoints, names)`, `sortStorageRows(rows, config, sort)`, `storageSeverity(row, config)`, **`buildStorageVolumes(storages, alloc, config, lunSizes?)`** (cartographie en arbre — voir §4B).
- Modèle de ligne (`StorageRowAll`) : key, endpointId/Name, storage, type, kind (shared/node), nodes[], **parentStorage?** (LUN iSCSI dont le datastore est un VG enfant — sert à la hiérarchie de la table), pct, used/total, hasCapacity, content[], vms[] {vmid, name, node, diskBytes, status}, running/stopped.
- Modèle volume (`StorageVolume`) : storage (référence = le LUN s'il a des VG enfants), type, **children[] (VG enfants, vide sinon)**, totalBytes/usedBytes (capacité du LUN comptée une fois · utilisé = Σ tailles VG), allocatedBytes (Σ disques VM), thinCapable, hasDisks, ratio, kind (overcommit/usage/na), tone, **totalSource? ('lun' | 'vg-sum' — borne basse)**.
- Config LUN : `storage-volumes.json` (racine repo, optionnel) `{ "lunSizes": { "<nom-iscsi>": octets } }` → `AppConfig.lunSizes` (chargé au démarrage, pas de hot-reload). Vide = capacités iSCSI en bornes basses.

## 6. i18n
Préfixes : `nav.storage`, `storage.*` (title, hint, loading, error, refresh, view.all, select.all, search.placeholder, export, empty, col.*, type.<type>, kind.shared, state.<sev>, vmstatus.*, stats, noVms, vmShown, showMore, na, **volumes.\*** (title, hint, thin, thick, capacity, allocated, overcommit, usage, na, vms, dupViews, dup)), `common.*`.

## 7. Décisions & pièges
- **PVE 9** : `/cluster/resources` ne renvoie plus le stockage des disques → parsé depuis la config VM (`VmConfigInfo.diskStorage`, côté serveur).
- Stockages thin (lvmthin/zfs/rbd) : taille virtuelle > espace réel possible — voir politique overcommit (skill `general` §7).
- **Hiérarchie iSCSI → LVM + dédoublonnage** : un LUN iSCSI + ses VG LVM = **un volume physique** (le LUN est le parent, les VG ses enfants). `duplicateOf` est posé **sur le LUN** = la **liste** de ses VG enfants (helper pur **`iscsiHostVgs`**, plusieurs VG possibles). Le poller **compte le LUN et exclut les VG enfants** (l'inverse de l'ancien dédoublonnage qui comptait le VG) — ne jamais sommer LUN + VG. Le LUN « utilisé » = **Σ tailles VG (engagé)**, pas les données. Voir skill `general` §7 + §10.
- **Ratio disk** : sur-allocation = disques **sur thin** / capacité thin (n/a si aucun disque sur un thin — pas de faux 916 %). Sur du thick, c'est un **usage** (≤1). Voir `buildStorageVolumes`.
- Capacité `na` : certains datastores n'exposent pas de capacité → barre à 0 + « — », ne pas traiter comme 0 %.
- Panneau Ceph / graphiques I-O = **phase 2, non implémentée** — ne pas ajouter sans accord utilisateur.
