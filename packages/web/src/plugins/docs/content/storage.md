# Stockage

Inventaire vCenter des **datastores Proxmox** (local, Ceph, NFS, ZFS, LVM, iSCSI…) : capacité, type, contenus et **VMs dont le disque y repose**, consolidés sur tous les endpoints.

- **Qui s'en sert** : la **DSI** / l'admin infra qui doit savoir ce qui est stocké où, combien de place reste, et quand un datastore va saturer.
- **Ce que ça fait** : Prox4u consolide les datastores de tous vos clusters Proxmox en une vue unique, avec capacité colorée selon la politique `overcommit.json`, hiérarchie physique iSCSI → LVM, et prévision de saturation par datastore.

---

## Comment s'en servir

### 1. Consulter l'inventaire des datastores

1. Ouvrez **Stockage** dans le menu (route `/storage`).
2. La page affiche, au-dessus de la table, le panneau **Volumes physiques** (voir étape 2), puis la **table des datastores** : une ligne par datastore, avec :
   - **Datastore** (icône par type) · **Serveur** (vue agrégée uniquement) · **Type** (badge, « Partagé » si partagé) · **Nœud** (ou « partagé ») ;
   - **Capacité** (barre colorée + utilisé/total) · **Contenu** · **VMs** (en marche + arrêtées) · **État** (badge **Nominal** / **À surveiller** / **Critique** / **Inconnu**).
3. Filtrez et triez :
   - **Rechercher** (datastore, type, nœud, VM, vmid…) ;
   - le **Type** (liste des types présents dans la vue courante) ;
   - le **Serveur** : **Tous les serveurs** ou un endpoint précis — la vue est **partageable par URL** ;
   - le **tri** sur les en-têtes (datastore, serveur, type, capacité, VMs, état).
4. Cliquez **Actualiser** pour recharger l'inventaire (cache serveur 5 min).

![Page Stockage — volumes physiques + table des datastores](/screenshots/storage.png)

### 2. Explorer les volumes physiques (iSCSI → LVM)

Le panneau **Volumes physiques** montre le stockage **en hiérarchie physique**, pas par datastore :
- un **LUN iSCSI** est le **volume de référence** (carte parent) ; les **VG LVM** qui reposent dessus sont **indentés** en dessous (connecteur « └ » + libellé « sous {LUN} ») ;
- la **capacité du LUN est comptée une seule fois** — jamais LUN + VG (les vues datastore redondantes sont regroupées) ;
- chaque volume est classé **Thin** (sur-allocation, peut dépasser 100 %) ou **Thick** (usage, ≤ 100 %), avec **Capacité réelle** (ou **Capacité (borne basse)** si la taille du LUN est inconnue), **Espace engagé (Σ VG)** et **Disques VM alloués**.

Dépliez ou repliez un LUN (**Déplier le LUN** / **Replier le LUN**) pour montrer ou masquer ses VG.

> Si un LUN affiche « Capacité (borne basse) », sa taille physique n'est pas connue de Proxmox : renseignez-la dans `storage-volumes.json` (`lunSizes`) pour afficher la vraie capacité.

### 3. Drill-down d'un datastore (grille personnalisable)

1. Dépliez une ligne de la table (chevron) : une **grille personnalisable** s'ouvre avec **3 widgets** :
   - **Occupation** — graphe d'historique, période **1 an** ou **31 j** ;
   - **Capacity planning** — jours avant 90 % + pente ;
   - **VMs hébergées** — nom, vmid, taille disque, nœud, état (50 par page, **Afficher plus**).
2. Personnalisez la grille : **glissez** les cartes par leur en-tête, **redimensionnez** avec la poignée, **Retirer** une carte (elle part dans la **Bibliothèque de graphiques**), réinsérez-la depuis la bibliothèque, ou **Réinitialiser la disposition**.
3. La disposition est **enregistrée pour votre compte, par datastore** — chaque utilisateur a sa propre vue.

### 4. Exporter l'inventaire

Cliquez **Export CSV** : un fichier plat, **une ligne par VM sur un datastore** (serveur, datastore, type, nature, nœud, vmid, VM, nœud de la VM, taille disque, état) — s'ouvre directement dans Excel.

---

## Ce qui se passe en fond

- **Inventaire** : le poller interroge Proxmox (`/cluster/resources` + config des VMs) et consolide l'inventaire ; l'endpoint `/api/storage-inventory` est **mis en cache 5 min** côté serveur.
- **Volumes physiques** : calculés par le poller (fonction pure, hiérarchie iSCSI → LVM, capacité du LUN comptée une fois) et poussés dans le **snapshot WebSocket** — zéro recalcul côté client.
- **Occupation + prévision** : l'historique est lu dans InfluxDB (`datastore_metrics`), avec **repli RRD Proxmox** si moins de 7 jours de données ; la prévision de saturation (jours avant 80/90 %, pente, projection 30 j) est calculée depuis cet historique.

| Événement | Quand | Détail |
|---|---|---|
| Rafraîchissement inventaire | à chaque tick du poller (5 s) + cache REST 5 min | relecture stockage + disques VM de chaque endpoint |
| Snapshot volumes physiques | poussé via WebSocket (5 s) | hiérarchie iSCSI → LVM recalculée, capacité comptée une fois |
| Série d'occupation | à la demande (drill-down) | InfluxDB `datastore_metrics`, repli RRD < 7 j |
| Prévision saturation | à la demande (drill-down) | jours avant 80/90 % + projection 30 j |

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Taille des LUN iSCSI | `storage-volumes.json` (racine repo, optionnel — `lunSizes`) | bornes basses (Σ VG) |
| Seuils de capacité | `overcommit.json` (hot-reload) | warn 70 % / crit 90 % |
| Layout du drill-down | par compte (`/api/user-config`, scope par datastore) | 3 widgets par défaut |

---

## Limites connues

- **Panneau Ceph + graphiques I/O** : phase 2, **non implémentée**.
- **Stockages thin** (LVM-thin / ZFS / Ceph RBD) : la taille virtuelle peut dépasser l'espace réel — voir la politique overcommit.
- **Capacité inconnue** : certains datastores n'exposent pas de capacité → barre vide + « — » (ne pas lire comme 0 %).
- **Taille des LUN** : sans `storage-volumes.json`, les capacités iSCSI sont affichées en **bornes basses** (somme des VG).
- **PVE 9** : le stockage des disques n'est plus dans `/cluster/resources` → il est parsé depuis la config des VMs (côté serveur).

---

## FAQ / dépannage

**Pourquoi un LUN affiche « Capacité (borne basse) » ?**
La taille physique du LUN n'est pas connue de Proxmox : la capacité affichée est la somme des tailles des VG qui reposent dessus. Renseignez la taille du LUN dans `storage-volumes.json` (`lunSizes`) pour afficher la vraie capacité.

**Pourquoi ne puis-je pas déplier une ligne de datastore ?**
Une ligne est dépliable si elle a des **VG enfants**, des **VMs hébergées**, ou une **capacité connue**. Un datastore sans VM et sans capacité (ex. un `dir` d'ISO/backups vide) ne s'ouvre pas.

**Pourquoi un VG LVM apparaît-il sous un LUN iSCSI ?**
Un LUN iSCSI et ses VG LVM sont **le même volume physique** : le LUN est le parent, les VG sont ses enfants. La capacité du LUN est comptée **une seule fois** (jamais LUN + VG) pour éviter le double-comptage.

**L'inventaire semble ancien ?**
L'endpoint est **mis en cache 5 min** côté serveur. Cliquez **Actualiser** : si le cache n'est pas expiré, la réponse peut rester celle du cache jusqu'à son expiration.

**Le graphe Occupation est vide ?**
Le poller enregistre l'historique en continu : les courbes se remplissent au fil des ticks. Moins de 7 jours de données → **repli RRD** ; aucun historique → message « historique insuffisant ».
