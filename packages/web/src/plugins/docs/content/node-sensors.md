# Capteurs nœuds

Affiche les **métriques locales** que l'API Proxmox ne donne pas — **SMART** des disques (détection prédictive des pannes), **températures** (CPU / disques / mémoire), **ZFS ARC**, **unités systemd** en échec — collectées par l'agent **Telegraf** tournant sur chaque nœud Proxmox.

- **Qui s'en sert** : la DSI / l'admin qui surveille la santé du matériel physique, et le **NOC** qui suit les alertes disques / températures.
- **Ce que ça fait** : Prox4u lit dans InfluxDB les mesures écrites par Telegraf sur chaque nœud, et les affiche dans 4 tableaux filtrables, avec **seuils personnalisés** et **historique des valeurs** (graphe 31 j / 1 an).

---

## Comment s'en servir

### 1. Consulter les capteurs des nœuds

1. Ouvrez la page **Capteurs nœuds** (route `/node-sensors`).
2. La page affiche **4 tableaux** :
   - **SMART** (disques) : nœud, device, modèle, santé, température, secteurs réalloués, usure NVMe ;
   - **Capteurs** (températures) : nœud, puce, feature, température, seuil critique, ventilateur ;
   - **ZFS ARC** : nœud, hits, misses, taille ;
   - **Unités systemd** : nœud, unité, `active`, `sub`, `load` — **uniquement les vraies alertes** (unités `failed` / `error`).
3. Utilisez le **filtre des sections** (menu déroulant multi-choix, option « Toutes ») pour afficher / masquer les tableaux.
4. Utilisez les **filtres colonnes** (multi-choix) pour restreindre par nœud, device, santé, etc.

> La **santé SMART** est tri-state : **OK** (vert) / **CRITIQUE** (rouge) / **Inconnu** (gris). Un disque sans SMART (virtuel, volume RAID) est « Inconnu », **pas** « CRITIQUE ». Une température de disque `0 °C` s'affiche « — » (aucun capteur).

![Page Capteurs nœuds — 4 tableaux et filtres](/screenshots/node-sensors.png)

### 2. Consulter l'historique d'un capteur ou d'un disque

1. Dans le tableau **Capteurs** ou **SMART**, cliquez sur l'**icône graphique** à côté d'une température (SMART : seulement si la lecture n'est pas `0 °C`).
2. La fenêtre **« Historique des valeurs »** s'ouvre :
   - l'identité (nœud / puce / feature, ou nœud / device) et la **dernière mesure** ;
   - le bascule **31 j / 1 an** ;
   - un **graphe redimensionnable** (drag du coin) — la taille est **persistée par cible** et par compte.
3. Lignes de référence : capteur → **seuil effectif** (rouge) + seuil firmware (gris, si seuil perso) ; SMART → ligne critique fixe **80 °C**.

> **Les trous de la courbe sont des données** : un nœud éteint ne mesure pas — les trous restent visibles, jamais comblés (pas d'interpolation).

### 3. Régler un seuil capteur personnalisé (admin)

1. Ouvrez **Administration → Seuils capteurs**.
2. Pour chaque capteur (nœud / puce / feature), saisissez un **seuil perso** — **toujours ≤ au seuil firmware** (la valeur est bornée).
3. Le tableau **Capteurs** colore les températures selon le **seuil effectif** (perso sinon firmware) : **critique** si le seuil est atteint, **alerte** dans la marge de 20 °C sous le seuil, **OK** sinon.
4. **Réinitialiser** un seuil (par ligne) ou **tout réinitialiser**.

> Ces seuils alimentent le module **Alarmes & Centreon** (règles « température > seuil effectif »).

### 4. Métriques système hôte (Vue d'ensemble + Monitor nœud)

Les mêmes mesures Telegraf alimentent aussi :
- la page **Vue d'ensemble** : carte **« Système — par nœud »** (tableau cross-nœud : load 1/5/15, iowait, swap, uptime) ;
- l'onglet **Monitor** du **détail nœud** (Vue VM) : sections **Système**, **CPU par cœur**, **I/O disques** (par device physique), **Réseau** (par interface), plus les graphes **températures**, **ZFS ARC**, **load**, **swap**.

Ces vues sont en lecture seule, aucune configuration requise — les données sont déjà dans InfluxDB.

---

## Ce qui se passe en fond

- L'agent **Telegraf** (bare-metal sur chaque nœud Proxmox) écrit ses mesures dans la base InfluxDB `raw` (rétention **31 j**) **toutes les ~10 s**.
- Prox4u lit le **dernier point par clé** (état courant, pas un agrégat), avec un **cache de 1 min**.
- Un **consolidateur 15 min** agrège `smart_device`, `sensors`, `zfs`, `systemd_units` (min / max) vers la base `consolidated` (rétention **∞**) → historique long terme pour le graphe 1 an.

| Événement | Quand | Détail |
|---|---|---|
| Mesure Telegraf | toutes les ~10 s | écriture dans la base `raw` |
| Cache Prox4u | 1 min | dernier état par nœud / device / puce / unité |
| Consolidation | 15 min | min / max vers `consolidated` (∞) |
| Historique des valeurs | à la demande | `raw` (buckets 10 min) + `consolidated` (15 min), cache 5 min |
| Métriques système hôte | à la demande | load / swap / iowait / par cœur, I/O par device — cache 5 min |

**Flux** : Telegraf (nœud) → InfluxDB `raw` → API Prox4u → page `/node-sensors` (et carte **Système** de la Vue d'ensemble + **Monitor nœud** de la Vue VM).

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Agent Telegraf | sur chaque nœud Proxmox (script `60-telegraf-nodes.sh`) | — |
| Rétention base `raw` | InfluxDB | 31 j |
| Consolidation `raw` → `consolidated` | Prox4u (auto) | 15 min (min / max) |
| Cache Prox4u | Prox4u (auto) | 1 min |
| Seuils capteurs perso | Admin → Seuils capteurs | seuil firmware |
| Seuil SMART critique | fixe | 80 °C (alerte 60 °C) |
| Marge d'alerte température | fixe | 20 °C sous le seuil |

---

## Limites connues

- **Agent Telegraf requis** : sans l'agent (ou non (re)déployé), les tableaux sont vides — la page affiche un état « aucune donnée » lisible, pas une erreur.
- **SMART** : un disque derrière un contrôleur RAID ou un disque virtuel ne renvoie pas de santé → « Inconnu » (pas « CRITIQUE »).
- **ZFS ARC** : sur un nœud sans pool ZFS (LVM), hits / misses sont à 0 — la série de hit rate est masquée.
- **Unités systemd** : seuls les états `failed` / `error` sont affichés — l'état `dead` (normal pour les one-shots / unités à la demande) est ignoré.
- **Historique I/O et réseau** : limité à 31 j (rétention `raw`).
- **Pools ZFS** (nom / état / taille) : pas encore alimentés.

---

## FAQ / dépannage

**Pourquoi les tableaux sont-ils vides ?**
L'agent Telegraf n'est pas installé (ou pas (re)déployé) sur le nœud. Lancez le script de déploiement `deploiement/60-telegraf-nodes.sh` sur le nœud ; les données apparaissent ensuite en quelques secondes.

**Pourquoi un disque affiche « Inconnu » en santé ?**
Le disque n'expose pas de SMART (disque virtuel, volume RAID, état illisible) — ce n'est **pas** une panne. Seul « CRITIQUE » (SMART `FAILED`) est une alerte.

**Pourquoi une température de disque s'affiche « — » ?**
`0 °C` signifie que le disque n'a pas de capteur de température.

**Pourquoi mon seuil est-il borné ?**
Un seuil perso **ne peut pas dépasser le seuil firmware** (borne appliquée à l'enregistrement). C'est volontaire : c'est une alerte plus stricte, pas plus lâche.

**Pourquoi des trous dans le graphe d'historique ?**
Un nœud éteint ne mesure pas. Les trous sont **des données**, jamais comblés (pas d'interpolation).

**Comment voir l'historique d'un disque ou d'un capteur ?**
Cliquez sur l'icône graphique à côté de la température dans le tableau **Capteurs** ou **SMART** → fenêtre « Historique des valeurs » (31 j / 1 an, graphe redimensionnable).
