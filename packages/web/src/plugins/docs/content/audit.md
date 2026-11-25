# Audit / best-practices

Calcule un **2ᵉ score de configuration** (en complément du health score, qui mesure les **ressources**) : il détecte les **écarts aux bonnes pratiques** Proxmox sur les données déjà pollées, et chaque constat est **cliquable** vers la cible concernée.

- **Qui s'en sert** : la **DSI / l'admin** qui veut un état des lieux de la configuration, et le **NOC** qui agit sur les constats.
- **Ce que ça fait** : Prox4u exécute **17 checks** de bonnes pratiques (VMs, réseau, stockage, système) sur chaque endpoint, calcule un **score déterministe** de 0 à 100, et affiche les constats groupés par sévérité — en direct, sans appel API au chargement de la page.

---

## Comment s'en servir

### 1. Activer le module (admin)

1. Le module est **activé par défaut** ; il suffit qu'il soit **autorisé** (activé globalement ou attribué à votre groupe) **et sélectionné** dans votre profil utilisateur.
2. Si le module n'apparaît pas dans le menu, vérifiez votre profil : un module non sélectionné redirige vers **Profil**.

### 2. Lire le score et les constats

1. Ouvrez **Audit** dans le menu (route `/audit`).
2. En multi-endpoints, choisissez l'**endpoint** à auditer.
3. Lisez la **carte score** :
   - le **grand chiffre** (0–100) et le **badge** : **≥ 80 Conforme**, **50–79 À améliorer**, **< 50 À revoir** ;
   - les **compteurs** de constats par sévérité (critique / avertissement / information) ;
   - le nombre de **checks passés** (ex. « 15/17 checks passés »).
4. Parcourez la section **constats**, groupée par sévérité (masquée si vide) : chaque ligne montre le badge de sévérité, le message, et un **bouton cliquable** qui vous emmène directement à la cible — la **VM** (page Inventaire VM), le **nœud** (page nœud), le **stockage** (page Stockage) ou le **cluster** (page endpoint).
5. Dépliez le **catalogue des checks** en bas de page : pour chaque check, il explique **pourquoi** (le risque), **comment** (la logique de détection) et le **seuil** appliqué.

![Page Audit — score de configuration, constats par sévérité et catalogue des checks](/screenshots/audit.png)

### 3. Suivre le score sans ouvrir la page

- **Vue d'ensemble** : le tableau des endpoints a une **colonne « Audit »** avec le score coloré (vert ≥ 80, orange 50–79, rouge < 50).
- **Détail d'endpoint** : le widget **« Score de configuration »** (jauge + liste des constats) est disponible dans la bibliothèque de widgets de la page endpoint.

### 4. Ajuster les seuils (optionnel, admin)

1. Copiez le template `audit.example.json` (racine du serveur) en `audit.json`.
2. Modifiez les **seuils** ou **désactivez** un check (`"enabled": false`).
3. **Aucun redémarrage** : le fichier est rechargé automatiquement au tick suivant (≤ 5 s). Un fichier invalide est ignoré (la config précédente est conservée).

---

## Ce qui se passe en fond

Le **poller** calcule l'audit **à chaque tick (5 s)** sur les données déjà pollées, puis le pousse dans le **snapshot WebSocket** : la page, la colonne de la vue d'ensemble et le widget endpoint le lisent **en direct, zéro API**.

| Donnée | Actualisation | Détail |
|---|---|---|
| Calcul de l'audit (17 checks) | chaque tick (5 s) | score + constats posés dans le snapshot |
| Configuration VM (autostart, CPU host, conteneur privilégié) | 1 h | API Proxmox |
| Âge du snapshot le plus vieux (par VM) | 1 h | 1 appel API/VM/h, en arrière-plan |
| Jobs de réplication, ponts et bonds | 5 min | API Proxmox |
| ZFS ARC, disques SMART, unités systemd, reboot en attente, mises à jour sécurité | 5 min | base InfluxDB, alimentée par l'**agent Telegraf** des nœuds |

- **Score déterministe** : `100 − Σ pénalités`, borné [0, 100] — pénalité **critique −10**, **avertissement −5**, **information −1**.
- **Pas de faux positifs** : si une donnée est absente (agent Telegraf non déployé, pas de snapshot, pas de bond…), le check correspondant est **silencieux** au lieu d'alerter à tort.
- Les checks système (disques, unités systemd, reboot, mises à jour) **nécessitent l'agent Telegraf** déployé sur les nœuds (`deploiement/60-telegraf-nodes.sh`).

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Check activé / désactivé (par check) | `audit.json` → `checks.<id>.enabled` | activé |
| Pénalités par sévérité | `audit.json` → `penalties` | crit −10 · warn −5 · info −1 |
| Libellés du score | `audit.json` → `labelNominal` / `labelDegraded` | ≥ 80 Conforme · 50–79 À améliorer · < 50 À revoir |
| Âge max des snapshots (`stuck_snapshots`) | `audit.json` → `maxAgeDays` | 7 j |
| Rétroaction max de la réplication (`replication_state`) | `audit.json` → `maxStalenessHours` | 24 h |
| Membres min. d'un bond (`bond_members`) | `audit.json` → `minMembers` | 2 |
| Max du ZFS ARC en % de RAM (`zfs_arc_max`) | `audit.json` → `maxPctOfRam` | 75 % |
| Usure NVMe (`disk_service_life`) | `audit.json` → `warnPct` / `critPct` | 80 % / 90 % |
| Nb de correctifs sécurité (`security_updates`) | `audit.json` → `warnCount` | 5 |

> Fichier absent ou clé manquante → **défaut intégré** : le serveur tourne sans `audit.json`.

---

## Limites connues

- **Lecture seule** : l'audit émet des constats, il ne corrige rien — chaque constat est un **point de départ** (cible cliquable) pour l'admin.
- **Agent Telegraf requis** pour les 5 checks système (disques SMART, usure NVMe, unités systemd, reboot en attente, mises à jour sécurité) : sans agent, ils sont silencieux (pas de faux positif, mais pas de contrôle non plus).
- **Un pont sans port physique est flagué (avertissement)** même s'il est volontaire (ex. pont NFS) : c'est un constat à revoir, pas une erreur.
- **Fraîcheur des données** : la configuration VM et l'âge des snapshots sont actualisées toutes les 1 h — un changement très récent peut mettre jusqu'à 1 h à apparaître dans l'audit.
- **Visibilité du module** : un module doit être à la fois autorisé (groupe) et sélectionné dans le profil utilisateur, sinon la route `/audit` redirige vers **Profil**.

---

## FAQ / dépannage

**Le module n'apparaît pas dans le menu / la page redirige vers Profil ?**
Le module doit être **autorisé** (activé globalement ou attribué à votre groupe) **et sélectionné** dans votre profil utilisateur. Les deux conditions sont nécessaires.

**Pourquoi mon score est-il à 100 alors que je vois des choses « bizarres » ?**
Le score ne pénalise que les 17 checks implémentés, avec les seuils en vigueur. Un état non couvert par un check (ou sous le seuil) ne retire aucun point. Le **catalogue des checks** liste exactement ce qui est contrôlé.

**Pourquoi certains checks ne donnent aucun constat ?**
Soit tout est conforme, soit la **donnée est absente** (agent Telegraf non déployé, pas de job de réplication, pas de bond, pas de snapshot…) : le check reste **silencieux** plutôt que d'alerter à tort.

**J'ai modifié `audit.json`, rien ne change ?**
1. Le fichier est-il à la **racine du serveur** (ou du répertoire de travail) ?
2. Vérifiez le log : `grep "modifié : configuration rechargée" logs/server.log`.
3. Un fichier **invalide** (mauvaise syntaxe JSON) est **ignoré** : la config précédente est conservée — corrigez la syntaxe.

**Un check me gêne, comment le désactiver ?**
Dans `audit.json`, mettez `"enabled": false` sur le check concerné : il est exclu du score et du nombre de checks exécutés, sans redémarrage.

**Quelle est la différence avec le health score ?**
Le **health score** mesure la **santé des ressources** (CPU, RAM, disque, nœuds en ligne, quorum). L'**audit** mesure la **qualité de la configuration** (bonnes pratiques). Les deux sont complémentaires : un cluster peut avoir un health score parfait mais un audit à revoir (ex. conteneurs privilégiés, VMs sans agent).
