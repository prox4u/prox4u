# Vue VM

Inventaire des **VMs et conteneurs LXC** de tout le parc multi-clusters Proxmox, présenté comme un vCenter : arborescence `Datacenter → cluster → nœud`, tableau live, et détails plein écran par VM et par nœud avec monitoring. **Lecture seule** : aucune action power (start/stop/reboot).

- **Qui s'en sert** : le DSI / admin Proxmox qui fait du drill-down sur le parc, et le NOC qui veut consulter l'état d'une VM ou d'un nœud et ouvrir sa console.
- **Ce que ça fait** : liste en continu (5 s) toutes les VMs et LXC de tous les endpoints, permet de les filtrer/trier/rechercher, d'ouvrir le détail d'une VM (Résumé / Monitor / Configuration / Réseau / Snapshots) ou d'un nœud (Résumé / Monitor / VMs), et d'ouvrir la console de la VM dans l'UI PVE.

---

## Comment s'en servir

### 1. Parcourir l'inventaire

1. Ouvrez **Vue VM** (route `/vms`).
2. À gauche, l'arborescence **Datacenter → cluster → nœud** : les VMs sont listées en feuilles sous chaque nœud, avec compteurs (en marche / total).
3. Au centre, le tableau multi-endpoints (VMs + LXC), **actualisé toutes les 5 secondes** :
   - recherche par **nom** (insensible à la casse) ou **VMID** exact ;
   - filtres par **statut** (running / paused / stopped) et par **type** (VM / LXC) ;
   - tri par n'importe quelle colonne : nom, VMID, nœud, type, statut, CPU, RAM, disque, **Agent PVE** ;
   - la colonne **Agent PVE** signale l'agent invité : badge vert **actif**, badge rouge **inactif** (VM en cours sans agent — à traiter), ou « — » si non applicable.
4. Cliquez sur une **VM** → son détail plein écran. Cliquez sur un **nœud** → son détail plein écran.
5. La sélection est dans l'URL (`?vm=`, `?node=`, `?tree=`, `?q=`, `?status=`, `?type=`) : le lien est partageable et se recharge tel quel.

![Inventaire VM — arborescence + tableau](/screenshots/vm-inventory.png)

### 2. Consulter le détail d'une VM

1. Cliquez sur la VM (dans l'arbre ou le tableau).
2. Le détail plein écran s'ouvre : en-tête (état, bouton **Console web**) + onglets **Résumé / Monitor / Configuration / Réseau / Snapshots**.
3. Onglet **Résumé** : 10 widgets — OS invité, détails, matériel, interfaces réseau, utilisation (barres CPU/RAM/disque), objets liés, et 3 graphiques de **capacity planning au niveau du cluster** (CPU / RAM / disque : quand la ressource sera saturée si la tendance continue).
4. Onglet **Monitor** : historiques CPU, RAM, disque, réseau (timeframes **1 h / 24 h / 7 j / 30 j**), occupation disque **par filesystem** (via l'agent invité), I/O **par disque** de la VM et trafic **par carte réseau** (un graphique par carte). Export **CSV** du timeframe affiché, par graphe.
5. Bouton **Console web** : ouvre la console de la VM **dans l'UI PVE** (nouvel onglet du navigateur).

![Détail VM — onglets Résumé / Monitor / Configuration / Réseau / Snapshots](/screenshots/vm-detail.png)

### 3. Consulter le détail d'un nœud

1. Cliquez sur un **nœud** de l'arborescence.
2. Le détail plein écran s'ouvre : en-tête (● en ligne / hors ligne, ratios de surallocation CPU/RAM, IP, uptime) + onglets **Résumé / Monitor / VMs**.
3. Onglet **Résumé** : 4 KPIs live (CPU, RAM, rootfs, charge moyenne) + 3 graphiques de **capacity planning au niveau du nœud** (le « disque » = le rootfs du nœud).
4. Onglet **Monitor** : deux sources indépendantes, mêmes timeframes et export CSV —
   - **historique PVE** : CPU, RAM, disque rootfs, réseau ;
   - **agent hôte Telegraf** : système (load 1/5/15, iowait, swap, uptime), CPU **par cœur** (barres en temps réel), I/O disques **par device physique**, réseau **par interface hôte** (les interfaces pare-feu PVE `fw*` sont décryptées), températures CPU/chips, températures et **santé des disques SMART**, **ZFS ARC**, charge moyenne, swap.
5. Onglet **VMs** : le tableau filtré sur ce nœud — cliquez sur une ligne pour passer au détail VM.

![Monitor nœud — widgets v4 (températures, SMART, ZFS ARC, load, swap)](/screenshots/node-monitor-v4-widgets.png)

### 4. Personnaliser les grilles (par utilisateur)

Les vues **Résumé** (VM et nœud) et **Monitor** (VM et nœud) sont des grilles personnalisables :

- **glisser-déposer** et **redimensionner** les cartes ;
- **retirer** une carte → elle part dans la **bibliothèque** de la page, d'où on la réinsère ;
- **Réinitialiser** (avec confirmation) pour revenir au layout par défaut ;
- le layout est **sauvegardé par compte, par VM et par nœud** — il est conservé à la reconnexion et ne concerne que vous.

> ⚠️ Un **renommage de nœud** remet les layouts du nœud (Résumé et Monitor) à zéro : le nom du nœud sert de clé.

---

## Ce qui se passe en fond

| Événement | Quand | Détail |
|---|---|---|
| Actualisation du tableau | toutes les **5 s** | push WebSocket (`snapshot.vms` par endpoint) — état, CPU, RAM, disque, agent |
| Détail VM | à l'ouverture | `GET /api/vm-config` : VM live, configuration (cache 1 h), snapshots (appel PVE à la demande, cache 5 min) |
| Historiques Monitor | à l'ouverture puis toutes les **60 s** | InfluxDB, timeframe affiché (1 h / 24 h / 7 j / 30 j) |
| Occupation disque par filesystem | au plus toutes les **5 min** par VM | le poller interroge l'agent invité (`get-fsinfo`), un seul appel par VM à la fois |
| Métriques agent hôte | toutes les **10 s** | Telegraf sur chaque nœud PVE (système, CPU par cœur, I/O disques, réseau, températures, SMART, ZFS ARC) |
| Capacity planning | à la demande, cache **5 min** | `GET /api/capacity` (cluster) et `GET /api/node-capacity` (nœud) — projection sur la tendance ≥ 7 j |

**Flux** : poller Proxmox (API PVE, token lecture seule) → InfluxDB (historiques) + snapshot WebSocket (live) → page `/vms`. Les métriques agent hôte arrivent par Telegraf (10 s) dans la base `raw` et sont servies par les endpoints `/api/node-*`.

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Version du module exposée | Administration → Versions | v4 (`vm-view_v4`) |
| Module activé / masqué | Administration (catalogue des modules) | activé |
| Layouts Résumé / Monitor | par utilisateur, par VM et par nœud (sauvegarde automatique) | layout par défaut |
| Token PVE | `.env` du serveur | lecture seule (`ManagerReader`) |
| Agent invité (QGA) | sur chaque VM (obligatoire pour l'occupation par filesystem et la colonne Agent PVE) | — |
| Agent hôte Telegraf | sur chaque nœud PVE (obligatoire pour les sections agent du Monitor) | — |

---

## Limites connues

- **Lecture seule** : pas d'actions power (start/stop/reboot), pas de création / migration / suppression de VM — itération dédiée à venir.
- **PVE 9** : selon le stockage, l'API renvoie `disk=0` dans `/cluster/resources` → le tableau affiche « 0 o / X To » (le détail affiche la même valeur live).
- **Console web** : désactivée en mode démo (endpoint sans URL PVE) — tooltip explicatif.
- **Renommage de nœud** : les layouts du nœud (Résumé et Monitor) sont remis à zéro (le nom du nœud est la clé de persistance).
- **Réseau par carte de la VM** : si la VM est arrêtée ou sur SDN (carte sans `tap` hôte), le graphique reste vide — jamais de valeur inventée.
- **Réseau du Monitor nœud** : `vnet*` / `tap*` / `veth*` / `lo` sont exclus (leur trafic est déjà dans le Monitor de chaque VM — double-comptage sinon).
- **Capacity planning** : nécessite ≥ 7 jours d'historique, sinon « données insuffisantes ».

---

## FAQ / dépannage

**Le tableau affiche « 0 o / X To » pour un disque ?**
Comportement connu de PVE 9 : l'API renvoie `disk=0` selon le stockage. Rien ne casse ; le détail VM affiche la même valeur live.

**Que veut dire la colonne « Agent PVE » ?**
Badge vert **actif** = l'agent invité (QGA) répond. Badge rouge **inactif** = la VM est en cours mais sans agent — critique pour l'occupation disque par filesystem. « — » = non applicable ou inconnu.

**Comment ouvrir la console d'une VM ?**
Bouton **Console web** dans l'en-tête du détail : ouvre la console dans l'UI PVE (nouvel onglet). Indisponible en mode démo.

**Le Monitor est vide ou affiche « données insuffisantes » ?**
Le nœud est trop récent, hors ligne, InfluxDB est KO, ou le nœud n'a pas l'agent Telegraf. Les deux sources (historique PVE et agent hôte) sont indépendantes : si l'une est vide, l'autre reste affichée avec son propre état vide.

**Puis-je déplacer les cartes du Résumé ou du Monitor ?**
Oui — glisser-déposer, redimensionner, retirer (→ **bibliothèque**), réinsérer, **Réinitialiser**. Le layout est sauvegardé par compte, par VM et par nœud.

**Comment revenir à une version antérieure du module ?**
L'admin active la version exposée dans **Administration → Versions** ; en attendant, les versions précédentes restent accessibles via `?v=vm-view_v3` ou `?v=vm-view_v2` dans l'URL.
