---
name: storage
description: Base de connaissance du plugin Storage de Prox4u — page /storage : inventaire vCenter des datastores (capacité, type, contenus, VMs hébergées), drill-down VMs, recherche, tri, export CSV, vue multi-endpoints. Use when working on the storage plugin (packages/web/src/plugins/storage/), the /storage page, the datastore table (storage-inventory.tsx), or any storage hypervision feature.
---

# Storage — Base de connaissance

Page `/storage` : **inventaire vCenter** des datastores — une ligne par datastore (barre de capacité, icône de type, nœud/partagé, contenus, VMs hébergées), dépliable vers les VMs dont le disque est sur ce datastore. Migrated from legacy (Strangler Fig, étape 4).

> Architecture globale : voir le skill `general`.

## 1. Manifest (`index.ts`)
- id `storage`, version 0.1.0. Route `/storage` → StoragePage. Menu `nav.storage` (icône HardDrive), order 30. `init()` : log uniquement.

## 2. Arborescence (3 fichiers)
| Fichier | Rôle |
|---|---|
| `pages/storage.tsx` | La page : fetch, sync URL (view/q/type), états loading/error, bouton Actualiser |
| `components/storage-inventory.tsx` | Table des datastores (~410 lignes) + helpers internes `CapacityBar`, `SortHead`, `FragmentRow` |

## 3. StoragePage — état et sync URL
- Données : `fetchStorageInventory()` au montage + bouton Actualiser (cache serveur 5 min).
- **Sync URL (deep-links partageables)** : `view` ('all' = vue agrégée, sinon id d'endpoint) · `q` (recherche) · `type` (type de datastore ; effacé quand la vue change).
- Noms d'endpoints issus du store WS (`useMulti()`).

## 4. StorageInventory — table vCenter
- **Colonnes** : datastore (icône par type) · serveur (vue agrégée uniquement) · type (badge, primary si partagé) · nœud (ou « partagé ») · capacité (barre + utilisé/total) · contenus · VMs (running+stopped) · état (badge sévérité).
- **CapacityBar** : fond = total, remplissage = utilisé, teinte = sévérité (`storageSeverity(row, config)` d'après overcommit.json) ; `na` → barre vide + « — ».
- **Tri** (`SortHead`) : datastore, serveur, type, capacité, vms, état — premier clic sur capacité/vms/état = décroissant.
- **Déroulé de type** : types présents dans la vue courante uniquement (dédoublonnés).
- **Drill-down** (`FragmentRow`) : dépliage d'une ligne → VMs du datastore (nom, vmid, taille disque, nœud, état) ; pagination `VM_PAGE = 50` + « Afficher plus » (garde-fou prod).
- **Export CSV** : inventaire plat — une ligne par VM sur un datastore (`serveur,datastore,type,nature,noeud,vmid,vm,noeud_vm,disque_octets,etat`), BOM `\ufeff` pour Excel, échappement soigné.

## 5. Données consommées
- REST : `fetchStorageInventory()` → `/api/storage-inventory` (cache serveur 5 min).
- Fonctions pures shared : `buildStorageInventory(storages, vms)`, `buildStorageInventoryAll(endpoints, names)`, `filterStorageRows(rows, q, {type})`, `sortStorageRows(rows, config, sort)`, `storageSeverity(row, config)`.
- Modèle de ligne (`StorageRowAll`) : key, endpointId/Name, storage, type, kind (shared/node), nodes[], pct, used/total, hasCapacity, content[], vms[] {vmid, name, node, diskBytes, status}, running/stopped.

## 6. i18n
Préfixes : `nav.storage`, `storage.*` (title, hint, loading, error, refresh, view.all, select.all, search.placeholder, export, empty, col.*, type.<type>, kind.shared, state.<sev>, vmstatus.*, stats, noVms, vmShown, showMore, na), `common.*`.

## 7. Décisions & pièges
- **PVE 9** : `/cluster/resources` ne renvoie plus le stockage des disques → parsé depuis la config VM (`VmConfigInfo.diskStorage`, côté serveur).
- Stockages thin (lvmthin/zfs/rbd) : taille virtuelle > espace réel possible — voir politique overcommit (skill `general` §7).
- Capacité `na` : certains datastores n'exposent pas de capacité → barre à 0 + « — », ne pas traiter comme 0 %.
- Panneau Ceph / graphiques I-O = **phase 2, non implémentée** — ne pas ajouter sans accord utilisateur.
