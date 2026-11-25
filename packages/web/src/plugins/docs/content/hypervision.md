# Vue d'ensemble

Donne une **vue en temps réel de tout le parc** (tous les clusters Proxmox) et permet de descendre jusqu'au **cluster** puis au **nœud**.

- **Qui s'en sert** : la DSI / l'admin qui veut une vue globale du parc, et le **NOC** qui surveille en continu les clusters, nœuds et VMs.
- **Ce que ça fait** : Prox4u agrège tous les endpoints Proxmox en une seule vue temps réel — ressources, Health Score, PRA (bascule N-1), surallocation, alertes — puis permet de descendre dans le détail d'un cluster et d'un nœud.

---

## Comment s'en servir

### 1. Ouvrir la vue d'ensemble

1. Cliquez sur **Vue d'ensemble** dans le menu de gauche (1ʳᵉ entrée).
2. La page affiche **tout le parc, multi-clusters** :
   - les **graphiques ressources** (CPU, RAM, disque — 7 jours) avec un **sélecteur de cluster** (« Tous les clusters » ou un cluster précis) ;
   - les **cartes KPI** (nœuds, CPU/RAM, stockage, VMs & conteneurs) — la carte VMs affiche un compteur **rouge** si des VMs n'ont pas d'**agent PVE** ;
   - la matrice **Nœuds — tous les clusters** (une ligne par nœud, groupés par cluster : état, CPU, RAM, disque, VMs) ;
   - la carte **Système — par nœud** (charge, I/O wait, swap, uptime) ;
   - le widget **Températures — par nœud** (max capteurs + max disques) ;
   - le widget **PRA global** (bascule cross-clusters) ;
   - le widget **InfluxDB 3 Core** (santé de la base de métriques) ;
   - les **cartes endpoints** (score de santé + état) et le **tableau endpoints** (état, nœuds, VMs, usages, surallocation, risque, score d'audit) ;
   - les **alertes** (les critiques d'abord).
3. Le **sous-menu Proxmox** (chevron sous « Vue d'ensemble ») liste tous les endpoints et nœuds — accès direct aux détails.

![Vue d'ensemble multi-clusters](/screenshots/overview.png)

### 2. Ouvrir le détail d'un endpoint (cluster)

1. Cliquez sur une **carte endpoint** ou une ligne du **tableau** (ou le sous-menu Proxmox).
2. La page affiche le **dashboard du cluster** (17 blocs) :
   - graphiques ressources 7 jours + KPIs avec sparklines ;
   - jauge **Health Score** (avec pénalités) ;
   - **PRA N-1** (bascule intra-cluster) ;
   - **capacity planning** (CPU/RAM/disque, avec projection) ;
   - **stockage**, **réseau** (trafic cluster), **top consommateurs** (VMs + pools) ;
   - **surallocation** (ratios + risque dynamique) ;
   - **tableau des nœuds** (lien vers le détail nœud) ;
   - **score de configuration** (audit) ;
   - **métriques du cluster** (CPU / RAM / réseau, une métrique à la fois, export CSV).
3. L'en-tête porte des **badges** d'état du cluster :
   - **Quorum** : vert « Quorum x/y » ou rouge « Quorum perdu » ;
   - **Qdevice** : 🟢 en ligne / 🔴 hors ligne ;
   - **Failover** : « API via … (nœud endpoint injoignable) » si Prox4u a basculé sur un autre nœud.

![Détail endpoint — dashboard du cluster](/screenshots/endpoint-detail.png)

![Quorum perdu + failover API](/screenshots/quorum-lost-failover.png)

### 3. Ouvrir le détail d'un nœud

1. Depuis la page cluster, cliquez sur un nœud dans le **tableau des nœuds** (ou la matrice « Nœuds — tous les clusters », ou le sous-menu).
2. La page affiche :
   - l'en-tête : nom du nœud, badge **en ligne / hors ligne**, badges de surallocation CPU/RAM, IP · version PVE · uptime ;
   - les **4 cartes KPI** (CPU, RAM, disque = disque système, charge) ;
   - la carte **Détails hôte** (identification + matériel CPU/DMI) ;
   - la carte **Capacité et utilisation** (barres utilisé vs capacité) ;
   - la **table des VMs** (vmid, nom, KVM/LXC, état, CPU, RAM) ;
   - les **graphiques du Monitor nœud** (système, CPU par cœur, I/O par disque, réseau par interface, températures, SMART, ZFS ARC, charge, swap).

![Détail nœud](/screenshots/node-detail.png)

### 4. Personnaliser la disposition

1. Sur les pages vue d'ensemble, cluster et nœud, chaque bloc est un **widget** que vous pouvez **déplacer** et **redimensionner** (glisser l'en-tête).
2. Cliquez sur **Bibliothèque** pour ajouter ou retirer des widgets, et sur **Réinitialiser** (avec confirmation) pour revenir à la disposition par défaut.
3. La disposition est **sauvegardée par compte et par page** — chaque utilisateur a sa propre vue.

---

## Ce qui se passe en fond

- **Temps réel (WebSocket)** : le serveur pousse un snapshot du parc **toutes les 5 s** — KPIs, état des nœuds, VMs, alertes, Health Score, quorum, Qdevice, score d'audit, PRA global, santé InfluxDB. Aucun rafraîchissement manuel.
- **Données lourdes (5 min)** : le capacity planning, les tendances et le risque dynamique sont rechargés au montage de la page puis **toutes les 5 min**.
- **Poller** : collecte en continu les données Proxmox (nœuds, VMs, stockage, cluster), les écrit dans **InfluxDB**, et calcule à chaque tick le Health Score, le PRA, le score d'audit et les alertes.
- **Quorum** : lu depuis `quorate` (PVE 9) ; s'il est perdu → Health Score −25 + alerte critique.
- **Qdevice** : état lu depuis corosync (agent Telegraf), repli par déduction API ; s'il est hors ligne → Health Score −10 + alerte warning.
- **Failover** : si le nœud endpoint est injoignable, Prox4u bascule automatiquement sur un autre nœud du cluster (badge « API via … »).
- **Capteurs / températures** : lus depuis l'agent **Telegraf** des nœuds (SMART, chips, ZFS ARC, unités systemd), cache serveur 1 min.

| Événement | Quand | Détail |
|---|---|---|
| Push snapshot (WS) | toutes les 5 s | KPIs, état, alertes, Health Score, quorum, Qdevice, audit, PRA global, InfluxDB |
| Rechargement données lourdes | au montage + toutes les 5 min | capacity planning, tendances, risque dynamique |
| Tick poller | continu | collecte Proxmox → InfluxDB + calcul scores/alertes |
| Rafraîchissement capteurs | 60 s (cache 1 min) | agent Telegraf (SMART, chips, ZFS ARC) |
| Ping InfluxDB | 60 s | santé de la base de métriques (ne bloque jamais le tick) |

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Disposition des pages (vue d'ensemble / cluster / nœud) | par user, sauvegardée automatiquement | disposition par défaut |
| Version du module | « Mon profil → Modules » | v4 (version courante) |
| Seuils de surallocation / d'usage | `overcommit.json` (hot-reload) | intégrés (si absent) |
| Seuils d'audit | `audit.json` (hot-reload) | intégrés (si absent) |

---

## Limites connues

- **Trous de données** : quand un nœud est éteint, ses données manquent (attendu, pas un défaut du pipeline).
- **Courbe disque** : s'accumule depuis le 1ᵉʳ tick — 7 jours pour une vue complète.
- **Réseau nœud (PVE ≥ 9)** : Proxmox ne renvoie plus le trafic par nœud ; la courbe est la somme des VMs en marche.
- **PRA global** : seulement si les nœuds sont répartis sur **≥ 2 sites** ; exige un **stockage ISO** d'un site à l'autre (prérequis documenté, pas de flag de config).
- **Fonctionnalités v4** (sélecteur de cluster, matrice nœuds, PRA global, Qdevice, widget InfluxDB…) : visibles seulement si l'utilisateur a sélectionné `hypervision_v4` dans « Mon profil → Modules ».
- **Timeframe 30 jours** : exige InfluxDB démarré avec `--query-file-limit=10000`.

---

## FAQ / dépannage

**La disposition n'est plus comme je veux ?**
Cliquez sur **Réinitialiser** (avec confirmation) pour revenir à la disposition par défaut. La disposition est sauvegardée par compte et par page.

**Un badge rouge « Quorum perdu » s'affiche ?**
Le cluster a perdu son quorum (majorité de nœuds hors ligne) → Health Score −25 + alerte critique. Sur un cluster avec Qdevice, la perte d'un seul nœud ne perd pas le quorum (le Qdevice le maintient).

**Un badge rouge « Qdevice hors ligne » s'affiche ?**
Le Qdevice (corosync) est hors ligne — le quorum n'est plus protégé si un nœud tombe. Health Score −10 + alerte warning. Pas d'incident immédiat tant que le quorum tient.

![Badge Qdevice en ligne](/screenshots/qdevice-online-badge.png)

**Un badge « API via … » s'affiche ?**
Le nœud endpoint est injoignable ; Prox4u a basculé automatiquement sur un autre nœud du cluster. Le badge disparaît dès que le nœud endpoint est de retour.

**Le compteur « N VMs sans agent PVE » est rouge ?**
Des VMs QEMU en cours n'ont pas l'agent invité (QGA) actif (critique). Vérifiez ces VMs dans l'inventaire.

**Le sélecteur de cluster ne change pas les KPIs ?**
Par design : le sélecteur ne pilote que les 3 graphiques 7 jours (courbes, valeur courante, ligne d'allocation). Les KPIs restent agrégés sur tous les clusters.

**La courbe disque est vide ou partielle ?**
Elle s'accumule depuis le 1ᵉʳ tick — 7 jours pour une vue complète. Les trous correspondent aux nœuds éteints.
