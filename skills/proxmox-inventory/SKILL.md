---
name: proxmox-inventory
description: Base de connaissance du plugin Inventaire Proxmox de Prox4u — page /proxmox-inventory : inventaire consolidé multi-endpoints, une machine par ligne (QEMU + LXC), avec OS réel (agent invité), disques par filesystem, interfaces + IPs, tags, notes, état de l'agent PVE. Recherche globale, filtres par colonne (dont filtre agent), tri, export TXT/CSV/JSON de la vue filtrée. Use when working on the proxmox-inventory plugin (packages/web/src/plugins/proxmox-inventory/), the /proxmox-inventory page, its table component, the /api/proxmox-inventory endpoint, or the @proxmox/shared/proxmox-inventory pure functions (InvVm, filterInvRows, sortInvRows, invSummary, invToFormat).
---

# Inventaire Proxmox — Base de connaissance

> 📖 **Notice utilisateur** : module « Documentation » de l'app — route `/docs/proxmox-inventory`, source `packages/web/src/plugins/docs/content/proxmox-inventory.md`.

Page `/proxmox-inventory` : **inventaire consolidé du parc multi-endpoints** — **une machine par ligne** (QEMU + LXC), toutes sources confondues : ressources live (`/cluster/resources`) **jointes aux données d'agent invité** (OS réel, disques par filesystem, interfaces/IPs) et à la **config PVE** (tags, notes, ostype). Recherche globale + **filtres par colonne** + tri ; **export TXT/CSV/JSON de la vue filtrée**.

> Architecture globale : voir le skill `general`. Fonctions pures : `@proxmox/shared/proxmox-inventory.ts`. Données d'agent : voir skill `vm-inventory` §7 (QGA, throttle, privilèges PVE).

## 1. Manifest (`index.ts`)
- id `proxmox-inventory`, version 0.1.0, aucune dépendance.
- Route : `/proxmox-inventory` → ProxmoxInventoryPage.
- Menu : `nav.proxmoxInventory` (icône `Boxes`), order 50.
- `init()` : log uniquement.

## 2. Arborescence (3 fichiers)
| Fichier | Rôle |
|---|---|
| `index.ts` | Manifest + init |
| `pages/proxmox-inventory.tsx` | La page : titre + aide, recherche, 9 cartes résumé, export, table |
| `components/proxmox-inventory-table.tsx` | Table triable + **filtres par colonne** (sommets de colonne) + rendu des cellules (badge agent, disques, IPs, tags…) |

## 3. Flux de données (serveur)
- `GET /api/proxmox-inventory` → `{ generatedAt, endpoints: ProxmoxInventoryEndpoint[] }` ; un endpoint = `{ endpointId, endpointName, vms: InvVm[] }` (tri par vmid).
- **Cache serveur 5 min par endpoint, STALE-WHILE-REVALIDATE** : on sert immédiatement la dernière valeur connue (même périmée) — la requête ne bloque **jamais** derrière un calcul agent. Le recompute part **en background** (single-flight par endpoint) dès que le cache est périmé ; l'échec est journalisé, le cache périmé continue d'être servi. Vrai cold start (aucune valeur) : on attend le calcul.
- **Réutilise `Prox4uClient`** (source unique avec le poller) : `getResources` + `getAgentBundle` (fsinfo/osinfo/interfaces). **Concurrence bornée à `AGENT_CONCURRENCY`** (`mapLimit`) : un guest lent (timeout 8 s) retient au plus `AGENT_CONCURRENCY` appels, pas N ; en régime établi (le poller a chauffé les **caches agent partagés** du client — fsinfo/osinfo 5 min, interfaces 60 s), ce sont des lectures de cache → quasi instantané.
- **Best-effort** : VM arrêtée / sans agent → `fs`/`osinfo` = `null`, `nets` = `[]` (pas d'erreur).

## 4. Fonctions pures (`@proxmox/shared/proxmox-inventory.ts`, 21 tests)
- **`InvVm`** : une machine — host, vmid, name, hostname, node, type, status, template, `osType`/`osPretty`/`osKernel`/`osArch`, cpuCores/cpuPct, ramAllocMb/ramUsedMb/ramUsedPct, uptimeS, tags, notes, `disks: InvDisk[]`, `interfaces: InvInterface[]`, `ips[]`, **`agentActive: boolean | null`**.
- **`filterInvRows(vms, f)`** : recherche globale (nom/hostname/vmid/node/type/status/OS/IPs/tags/notes, insensible à la casse) + filtres `node`/`type`/`status`/`agent`/plages `cpu`/`ram`/`disk`. `DEFAULT_INV_FILTER` (tout vide).
- **`sortInvRows(vms, key, dir)`** : clés `name`/`vmid`/`node`/`type`/`status` (ordre running→paused→stopped→unknown)/`agentActive`/`cpuCores`/`cpuPct`/`ramAllocMb`/`ramUsedMb`/`ramUsedPct`/`uptimeS`/`diskMb`. **nulls last** pour les clés numériques, quel que soit le sens.
- **`invSummary(vms)`** : agrégats de l'en-tête — total, running, stopped, ramAllocMb, ramUsedMb, cpuCores, cpuPctAvg (moyenne sur les VMs avec CPU défini), **`agentOk` = nombre de VMs dont l'agent invité est ACTIF** (`agentActive === true`, exact — remplace l'ancienne heuristique interfaces/disques).
- **`invToTxt` / `invToCsv` / `invToJson` / `invToFormat(fmt, vms)`** : export de la **vue filtrée** (pas de tout l'inventaire).
- **Décodeur famille OS** : `osFamilyFromId` (id distro de l'agent → Windows / Linux-Unix / Autre), `ostypeFamily` (code `ostype` de la config, repli VMs arrêtées/sans agent : `w*`/`windows` = Windows, le reste non-`none` = Linux/Unix), `osPrettyFromOstype`, `osDisplay`, `archLabel` (normalise `amd64`→`x86_64`), `fmtSize`, `invTotalDiskMb`.

## 5. Page (`/proxmox-inventory`)
- **En-tête** : titre `h1` (`pxinv.title`) + badge version + ligne d'aide (`pxinv.hint`) à gauche ; à droite bouton **Rafraîchir** + sélecteur de format (**CSV** / TXT / JSON) + bouton **Exporter** (télécharge la vue filtrée).
- **Recherche globale** (champ avec icône) + **9 cartes résumé** (total, affichées, running, stopped, RAM all., RAM used, cœurs CPU, CPU moy., **Agent OK n/total**).
- **Table** (`ProxmoxInventoryTable`) : triable par en-tête, **filtres par colonne** dans les sommet (node/type/status/**agent**/plages cpu/ram/disk). Pied de page : horodatage de génération + `affichées/total`.
- Chargement : skeleton ; erreur : bannière critique (`pxinv.error`).

## 6. Colonnes & filtres par colonne
Colonnes : `name`, `hostname`, `vmid`, `host` (endpoint), `node`, `type`, `status`, **`agentActive` (Agent PVE)**, `osType` (OS), `cpuCores`, `cpuPct`, `ramAllocMb`, `ramUsedMb`, `ramUsedPct`, `uptimeS`, `disks` (par fs), `interfaces`, `ips`, `tags`, `notes`, `template`.
- **Filtre par colonne** : `node`/`type`/`status` = **distinct** des valeurs présentes ; **`agent` = valeurs fixes** `actif`/`inactif`/`n-a` (pas de distinct) ; `cpu`/`ram`/`disk` = **plages min/max**.
- Rendu cellule agent : `null` → « N/A » · `true` → badge vert « actif » · `false` → **badge rouge « inactif »** (critique).

## 7. État de l'agent PVE (`agentActive`) — sémantique
- `true` = **QGA répond** (`get-fsinfo` ok — y compris `[]` : agent vivant, aucun fs sur disque VM).
- `false` = VM **QEMU en cours** mais agent non démarré / injoignable → **CRITIQUE** (badge rouge + compteur).
- `null` = **n/a** (LXC, VM arrêtée, template — l'agent invité n'existe pas pour eux) **ou inconnu** (cache agent pas encore réchauffé au démarrage).
- Dérivation route : `v.type === 'qemu' && v.status === 'running' ? fs !== null : null`. **Zéro appel API additionnel** : `fs` est déjà reçu dans le bundle agent.

## 8. i18n
Préfixe `pxinv.*` (+ `nav.proxmoxInventory`) dans `@proxmox/shared/i18n` (fr/en) : `pxinv.title/hint/search/refresh/export(.csv/.txt/.json)/error/loading/generated/shown`, `pxinv.summary.*` (9 cartes), `pxinv.col.*` (colonnes), `pxinv.agent.active/down`, `pxinv.filter.all/min/max/contains`, `pxinv.na`.

## 9. Décisions & pièges
- **Une machine par ligne, multi-endpoints** : le champ `host` = id de l'endpoint (pas de colonne de regroupement) — la recherche/filtre couvrent tous les endpoints à la fois.
- **Export de la VUE FILTRÉE** (pas de l'inventaire complet) : `invToFormat(fmt, rows)` sur les lignes déjà filtrées+triées.
- **STALE-WHILE-REVALIDATE** : ne jamais bloquer la requête sur un calcul agent (le poller chauffe les caches en background ; ici on sert le cache périmé + recompute async).
- **OS réel vs config** : `osType`/`osPretty`/`osKernel`/`osArch` = **agent d'abord** (OS réel), **config PVE en repli** (VMs arrêtées / sans agent) — voir skill `vm-inventory` §7 pour les privilèges PVE (`VM.GuestAgent.Audit` suffit).
- **`agentOk` exact** : compte `agentActive === true` (les `null` LXC/arrêtées ne comptent pas) — l'ancienne heuristique (interfaces ou disques non vides) surestimait.
