# InfluxDB 3 Core

Surveille la **santé** de la base de métriques **InfluxDB 3 Core** qui alimente tous les graphiques de Prox4u, et permet d'**agir** dessus (flush, archivage, export, recréation / suppression de bases et tables).

- **Qui s'en sert** : la **DSI / admin** qui surveille la base et intervient dessus, et le **NOC** qui suit la santé en continu.
- **Ce que ça fait** : Prox4u lit l'état de la base InfluxDB (état, version, file d'écriture, lignes abandonnées, latence, headroom fichiers), affiche son historique de santé (24 h / 7 j / 30 j), liste les bases et leur rétention, suit l'archivage CSV, et propose des actions d'administration restreintes aux groupes autorisés.

---

## Comment s'en servir

### 1. Consulter la santé de la base (tout le monde)

1. Ouvrez **InfluxDB** dans la barre latérale (route `/influxdb`).
2. La rangée de **KPIs** affiche l'état en direct :
   - **État** : En ligne / Hors ligne / Désactivé ;
   - **Version** (si l'API InfluxDB la fournit) ;
   - **File d'écriture** : lignes en attente d'écriture ;
   - **Lignes abandonnées** : lignes perdues (file saturée) — surligné si > 0 ;
   - **Latence requête** : durée de la dernière requête ;
   - **Headroom fichiers** : OK / À surveiller / Critique (marge avant la limite de fichiers InfluxDB).
3. La page se **rafraîchit toutes les 30 secondes**.

![Page InfluxDB — KPIs de santé](/screenshots/influxdb.png)

### 2. Consulter l'historique de santé

1. Dans la carte **Historique — santé InfluxDB**, choisissez la **fenêtre** : **24 heures**, **7 jours** ou **30 jours**.
2. Quatre graphiques :
   - **File d'écriture** (lignes) ;
   - **Lignes abandonnées (cumul)** ;
   - **Latence requête** (ms) ;
   - **Débit d'écriture** (lignes/s).

### 3. Consulter les bases et l'archivage

1. La carte **Bases** liste chaque base InfluxDB et sa **rétention** (« infinie » si aucune).
2. La carte **Archivage (consolidated → CSV)** affiche :
   - la **Dernière borne archivée** ;
   - le nombre de **Fichiers** et leur taille totale ;
   - le **Dossier** d'archivage.

### 4. Agir sur la base (groupes autorisés)

Le panneau **Actions** n'est visible que si votre compte est **admin** ou membre d'un des groupes autorisés (défaut : **Administrateurs**, **Exploitations**).

1. **Actions sans risque** (1 clic) :
   - **Forcer un flush** : vide immédiatement la file d'écriture ;
   - **Archiver maintenant** : déclenche un cycle d'archivage ;
   - **Réinitialiser l'archivage** : relance l'archivage depuis le début ;
   - **Exporter (CSV)** : exporte **une ou plusieurs tables** de la base `consolidated` sur une période (**Du**, **Au**) — une **liste de tables** (choix multiple + **Toutes**) ; le résultat est **1 fichier ZIP contenant 1 CSV par table** déposé dans le dossier d'archivage.
2. **Actions destructives** (dialogue de confirmation) :
   - **Recréer une base** : supprime puis recrée la base (données perdues), avec une **rétention** optionnelle (ex. `2y`, `365d` — vide = infinie) ;
   - **Supprimer une base** : supprime définitivement la base et toutes ses tables ;
   - **Supprimer une table** : supprime définitivement une table d'une base.
3. Le **résultat** de chaque action s'affiche (succès / échec) et la page se rafraîchit.

---

## Ce qui se passe en fond

Prox4u écrit en continu les métriques Proxmox dans InfluxDB 3 Core, puis les consolide et les archive :

| Événement | Quand | Détail |
|---|---|---|
| **Écriture des métriques** | à chaque tick du poller | les métriques Proxmox entrent dans la **file d'écriture** InfluxDB |
| **Auto-telemetry** | à chaque tick | 1 ligne `influxdb_self` dans la base `raw` (file, abandons, latence) — alimente les graphiques |
| **Consolidation** | fenêtre de **5 min** | agrège la base `raw` (31 j) vers la base `consolidated` (rétention infinie) |
| **Archivage CSV** | toutes les **6 h** | exporte par incréments les données `consolidated` plus anciennes que **90 j** en CSV |
| **Ping de santé** | toutes les **60 s** | vérifie que la base répond (mis en cache, ne bloque jamais le tick) |

**Alertes** : Prox4u lève 3 alertes automatiques — **InfluxDB indisponible** (repli RRD actif), **lignes de métriques abandonnées** (file saturée), **limite de fichiers approchée** (requêtes long terme).

**Flux** : poller Proxmox → file d'écriture InfluxDB → base `raw` → consolidateur (5 min) → base `consolidated` → archiver (6 h) → CSV.

**Repli** : si InfluxDB est indisponible, l'historique bascule automatiquement sur les **RRD Proxmox** (`source: 'rrd'`) — jamais de crash.

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Groupes autorisés aux actions | `.env` `INFLUX_ACTION_GROUPS` | `Administrateurs,Exploitations` |
| Intervalle d'archivage | `.env` `INFLUX_ARCHIVE_INTERVAL_HOURS` | 6 h |
| Âge minimal archivé | `.env` `INFLUX_ARCHIVE_AGE_DAYS` | 90 j |
| Dossier d'archivage | `.env` `INFLUX_ARCHIVE_DIR` | `data/influx-archive` |
| Base consolidée | `.env` `INFLUX_AGG_DB` | `consolidated` |
| Fenêtre de consolidation | code (fixe) | 5 min |
| Chunk de requête | `.env` `INFLUX_QUERY_CHUNK_DAYS` | 30 j |
| Limite de fichiers requête | `.env` `INFLUX_QUERY_FILE_LIMIT` | 10 000 |

---

## Limites connues

- **Version « — »** : certaines versions d'InfluxDB 3 Core ne renvoient pas la version (`/api/v3/server-info` en 404) → affichée « — ».
- **Rétention immuable** : en Core, la rétention d'une base existante ne peut pas être modifiée — pour la changer, il faut **recréer** la base (données perdues).
- **Actions restreintes** : sans rôle admin ni groupe autorisé, le panneau **Actions** est masqué (403 côté API).
- **Export CSV (ZIP)** : l'export ad-hoc produit **1 CSV par table, regroupés dans un fichier ZIP** (pas de Parquet), déposé dans le dossier d'archivage.

---

## FAQ / dépannage

**La page affiche « InfluxDB désactivé » ?**
InfluxDB n'est pas activé (ou en mode mock) : la page est en lecture seule et l'historique bascule sur le repli RRD Proxmox. Activez InfluxDB côté serveur pour retrouver les KPIs et les actions.

**Le KPI « Lignes abandonnées » est > 0 ?**
La file d'écriture s'est saturée : des lignes de métriques ont été perdues. Utilisez **Forcer un flush** pour vider la file et vérifiez que la base répond (**État** = En ligne). L'alerte « lignes abandonnées » est levée automatiquement.

**Le KPI « Headroom fichiers » est « À surveiller » / « Critique » ?**
Les requêtes long terme s'approchent de la limite de fichiers InfluxDB 3 Core. Réduisez la fenêtre des graphiques, ou augmentez `INFLUX_QUERY_FILE_LIMIT` / diminuez `INFLUX_QUERY_CHUNK_DAYS`. L'alerte « limite de fichiers » est levée automatiquement.

**Le panneau « Actions » n'apparaît pas ?**
Votre compte n'est ni **admin** ni membre d'un des groupes de `INFLUX_ACTION_GROUPS`. Demandez à un admin de vous ajouter au groupe (défaut : **Administrateurs**, **Exploitations**).

**Comment exporter un historique précis ?**
**Exporter (CSV)** : cochez les **tables** voulues dans la liste (base `consolidated` — choix multiple ou **Toutes**), la période **Du / Au**, et validez. Le **ZIP** (1 CSV par table) est déposé dans le dossier d'archivage.

**Comment changer la rétention d'une base ?**
En Core la rétention est immuable : utilisez **Recréer une base** avec la nouvelle **rétention** (ex. `2y`, `365d`). La base est supprimée puis recréée — les données existantes sont perdues.
