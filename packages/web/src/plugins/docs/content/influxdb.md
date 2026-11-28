# InfluxDB 3 Core

Surveille la **santé** de la base de métriques **InfluxDB 3 Core** qui alimente tous les graphiques de Prox4u, et permet d'**agir** dessus (flush, archivage, export, **sauvegarde / restauration** de bases, recréation / suppression de bases et tables).

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

1. La carte **Bases** liste chaque base InfluxDB et sa **rétention** (« — » si inconnue — l'API InfluxDB 3 Core ne l'expose pas).
2. La carte **Archivage (consolidated → CSV)** affiche :
   - la **Dernière borne archivée** ;
   - le nombre de **Fichiers** et leur taille totale ;
   - le **Dossier** d'archivage.
3. La carte **Dimensionnement** (calculateur P3) recommande la config InfluxDB 3 Core adaptée au **parc réel** (VMs / nœuds / datastores du dernier poll + tick) : **file d'écriture**, **flush**, **query-file-limit**, **rétention** — avec la **justification** (repliable) et des **avertissements** si la config actuelle est sous-dimensionnée. Utile avant un déploiement prod (dimensionner sans deviner).

### 4. Agir sur la base (groupes autorisés)

Le panneau **Actions** n'est visible que si votre compte est **admin** ou membre d'un des groupes autorisés (défaut : **Administrateurs**, **Exploitations**).

1. **Toutes les actions passent par une étape de validation** : avant l'exécution, un dialog explique **ce qui va se produire** et l'**impact** (réversible ou non), avec un **niveau de risque** (🟢 Sûre / 🟠 Attention / 🔴 Critique) et les paramètres de l'action — boutons **Annuler / Continuer**.
2. **Actions sûres** (🟢) :
   - **Forcer un flush** : vide immédiatement la file d'écriture ;
   - **Archiver maintenant** : déclenche un cycle d'archivage ;
   - **Exporter** : exporte **une ou plusieurs tables** de la base `consolidated` sur une période (**Du**, **Au**), au **format CSV ou Parquet** — une **liste de tables** (choix multiple + **Toutes**) ; le **ZIP** (CSV : 1 fichier par table ; Parquet : 1 fichier par tranche de 30 j) est généré en mémoire et **téléchargé automatiquement** dans le dossier de téléchargements du navigateur — **aucun fichier n'est conservé sur le serveur**. Le **résultat** de l'action affiche le nombre de tables (et de lignes en CSV) exportées.
   - **Sauvegarder une base** : crée une **sauvegarde complète** d'une base (toutes les tables, historique complet) — un **ZIP persistant** (`1 CSV par table + manifeste`) est conservé **sur le serveur** (dossier de sauvegardes). Le **résultat** affiche le nom du fichier + un lien **Télécharger** (optionnel) pour le récupérer dans le navigateur.
3. **Actions d'attention** (🟠) :
   - **Réinitialiser l'archivage** : relance l'archivage depuis le début (prochain cycle plus long) ;
   - **Restaurer une base** : réinjecte les données d'une **sauvegarde** (choisie dans la liste des sauvegardes du serveur) dans sa **base d'origine**. La base est recréée si absente ; si les tables existent déjà, les lignes sont **ajoutées** (doublons possibles).
4. **Actions critiques** (🔴, irréversibles) :
   - **Recréer une base** : supprime puis recrée la base (données perdues), avec une **rétention** optionnelle (ex. `2y`, `365d` — vide = infinie) ;
   - **Supprimer une base** : supprime définitivement la base et toutes ses tables — case optionnelle **« Sauvegarder une copie de sécurité avant suppression »** : une sauvegarde complète est créée **avant** le drop (la validation 🔴 l'indique, et le résultat propose le **Télécharger** de la copie) ;
   - **Supprimer une table** : supprime définitivement une table d'une base.
5. Le **résultat** de chaque action s'affiche (succès / échec) et la page se rafraîchit.

### 5. Sharding multi-InfluxDB par endpoint (admin)

Quand un seul nœud InfluxDB ne suffit plus (volume d'écriture, headroom fichiers, performance des requêtes), les métriques peuvent être **réparties sur plusieurs instances InfluxDB** — une par endpoint. La fonctionnalité est **dormante par défaut** : sans shard configuré, tout transite par l'instance globale (zéro changement de comportement).

1. Ouvrez **Administration** → onglet **Shards InfluxDB** (rôle admin).
2. **Ajouter un shard** : choisissez l'**endpoint** (menu déroulant), l'**URL de l'instance** (`https://hote:8181`), et éventuellement le **token** (vide = token global), les **bases raw / consolidée** (vide = globales) et le **certificat CA**.
3. **Tester** la connexion (ping), **modifier**, **retirer** le shard, ou **Tout retirer** (retour à l'instance unique).
4. La config est persistée dans `data/influx-shards.json` et le routeur est **rechargé à chaud** (sans redémarrage). La santé de chaque shard (ping / version / bases / file d'écriture) est visible dans la réponse `GET /api/influxdb` (champ `shards`).

**Comment ça marche** :
- **Écritures** : les métriques API PVE du poller pour un endpoint vont dans le shard de cet endpoint (s'il est configuré), sinon dans l'instance globale.
- **Lectures** : Prox4u interroge l'instance globale **et** tous les shards (fan-out) et fusionne les résultats — l'historique reste **complet** (les données pré-sharding, dans le global, sont incluses).
- **Données Telegraf** (capteurs nœuds) : écrites directement par l'agent Telegraf de chaque nœud. Pour les sharder, il faut **reconfigurer Telegraf sur chaque nœud** pour qu'il pointe vers le shard de son endpoint (étape de déploiement — Phase 1).
- **Consolidation / archivage** : chaque instance consolide et archive ses propres données (les shards écrivent dans un sous-dossier `/<endpointId>/`).

> **À noter** : activer le sharding (déployer les instances par endpoint + reconfigurer Telegraf + décider de la migration de l'historique) est une étape de **déploiement** (Phase 1), pas un simple clic. Le code de la Phase 0 est en place et dormant.

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
| Dossier de sauvegardes | `.env` `INFLUX_BACKUP_DIR` | `data/influx-backups` |
| Base consolidée | `.env` `INFLUX_AGG_DB` | `consolidated` |
| Shards par endpoint | `data/influx-shards.json` (UI admin) | vide (dormant) |
| Fenêtre de consolidation | code (fixe) | 5 min |
| Chunk de requête | `.env` `INFLUX_QUERY_CHUNK_DAYS` | 30 j |
| Limite de fichiers requête | `.env` `INFLUX_QUERY_FILE_LIMIT` | 10 000 |

---

## Limites connues

- **Version « — »** : certaines versions d'InfluxDB 3 Core ne renvoient pas la version (`/api/v3/server-info` en 404) → affichée « — ».
- **Rétention immuable** : en Core, la rétention d'une base existante ne peut pas être modifiée — pour la changer, il faut **recréer** la base (données perdues).
- **Actions restreintes** : sans rôle admin ni groupe autorisé, le panneau **Actions** est masqué (403 côté API).
- **Export CSV/Parquet (ZIP)** : l'export ad-hoc produit, au **format CSV** (1 fichier par table) ou **Parquet** (1 fichier par tranche de 30 j, ~×3 plus compact, lecture analytique DuckDB/Excel), un **fichier ZIP** **téléchargé directement** dans le navigateur — aucun fichier conservé sur le serveur.

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
**Exporter** : cochez les **tables** voulues dans la liste (base `consolidated` — choix multiple ou **Toutes**), la période **Du / Au**, le **format** (CSV ou Parquet), et validez. Le **ZIP** est **téléchargé automatiquement** dans le dossier de téléchargements du navigateur (aucun fichier conservé sur le serveur).

**Comment changer la rétention d'une base ?**
En Core la rétention est immuable : utilisez **Recréer une base** avec la nouvelle **rétention** (ex. `2y`, `365d`). La base est supprimée puis recréée — les données existantes sont perdues.

**Comment sauvegarder une base avant de la supprimer ?**
Deux façons : **Sauvegarder une base** (action 🟢, crée un ZIP persistant sur le serveur, téléchargeable), ou **Supprimer une base** en cochant **« Sauvegarder une copie de sécurité avant suppression »** (la sauvegarde est créée juste avant le drop). Le ZIP contient **1 CSV par table + un manifeste** (schéma des tables) — c'est ce manifeste qui permet la restauration.

**Comment restaurer une base supprimée ?**
**Restaurer une base** (action 🟠) : choisissez la **sauvegarde** dans la liste (les sauvegardes du serveur sont listées avec leur date, base, nombre de tables/lignes). La restauration réinjecte les données dans la **base d'origine** du manifeste — la base est recréée si absente. ⚠️ Si la base existe déjà, les lignes sont **ajoutées** (doublons possibles) : supprimez d'abord la base (sans sauvegarde) pour une restauration propre.

**Où sont stockées les sauvegardes ?**
Sur le **disque du serveur**, dans le dossier de sauvegardes (`.env` `INFLUX_BACKUP_DIR`, défaut `data/influx-backups`). Elles sont **téléchargeables** depuis l'UI (lien **Télécharger** dans le résultat de l'action) — pensez à les copier ailleurs si vous voulez une copie hors serveur.

**Comment répartir les métriques sur plusieurs instances InfluxDB (sharding) ?**
Via **Administration** → **Shards InfluxDB** : ajoutez un shard par endpoint (URL de l'instance, token/bases/CA optionnels — vide = hérité du global). Le code est **dormant** : sans shard, tout reste sur l'instance globale. Pour une activation complète (Phase 1), il faut en plus déployer les instances par endpoint et **reconfigurer Telegraf sur chaque nœud** pour qu'il écrive dans le shard de son endpoint — les lectures, elles, sont automatiquement en fan-out (global + shards) et restent complètes.
