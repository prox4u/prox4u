# Alarmes & Centreon

Transforme des **règles de surveillance** sur vos VMs, nœuds et clusters Proxmox en **alarmes** envoyées à **Centreon** (checks passifs NSCA).

- **Qui s'en sert** : le manager / DSI qui définit les seuils d'alerte, et le **NOC** Centreon qui reçoit les statuts.
- **Ce que ça fait** : Prox4u surveille en continu les métriques Proxmox, et dès qu'un seuil est franchi, envoie une alarme à Centreon. Quand la situation se rétablit, envoie une récupération.

---

## Comment s'en servir

### 1. Activer le module et le configurer (admin)

1. Ouvrez **Administration → Centreon (NSCA)**.
2. Activez le module.
3. Renseignez :
   - le **central Centreon** (adresse du serveur NSCA, port, mot de passe NSCA) ;
   - les **pollers** (nom + IP) — la destination NSCA suit l'IP du poller cible ;
   - le **transport de provisioning** : **CLAPI** (recommandé, SSH) ou **REST v1** ;
   - le **mapping VM → hôte Centreon** (quel hôte Centreon correspond à quelle VM).
4. Réglez les **trames périodiques** (voir ci-dessous).

> Le mot de passe NSCA, le token REST et le mot de passe CLAPI peuvent être fournis via le `.env` du serveur (`CENTREON_NSCA_PASSWORD`, `CENTREON_REST_TOKEN`, `CENTREON_CLAPI_PASSWORD`) — ils prévalent sur la saisie dans l'interface.

![Administration — onglet « Centreon (NSCA) »](/screenshots/admin-centreon-nsca.png)

### 2. Créer une règle d'alarme

1. Ouvrez **Alarmes & Centreon → Nouvelle règle**.
2. Choisissez :
   - la **cible** : une VM, un nœud (y compris les **capteurs** du nœud — voir ci-dessous), ou un cluster (quorum / Qdevice) ;
   - la **métrique** : CPU, RAM, disque, statut VM, IP joignable, uptime, réseau, en ligne nœud, quorum, **ou une métrique capteur** (température SMART, santé SMART, température capteur, unité systemd, état pool ZFS) ;
   - la **condition** : seuil (ex. CPU > 90 %), sens (supérieur / inférieur), sévérité (WARNING / CRITICAL) ;
   - la **fenêtre de confirmation** : la condition doit tenir sur toute la fenêtre avant d'alerter (évite les à-coups).
3. Enregistrez : Prox4u **provisionne le service Centreon** (service passif), puis enregistre la règle.

![Créer une surveillance — formulaire de règle](/screenshots/alarms-new.png)

### 3. Gérer les règles

Dans **Alarmes & Centreon**, le tableau liste toutes les règles avec :
- filtres (texte, poller, état, provisioning) et recherche ;
- actions : **activer / désactiver**, **modifier**, **supprimer**, **Tester** (envoie une trame de test), **Reprovisionner** (recrée le service Centreon).

**Supprimer une règle** retire aussi le **service Centreon associé** (cohérence Prox4u ↔ Centreon) :
- si le central est joignable, le service est supprimé puis la règle retirée (flash « Règle supprimée — service Centreon supprimé ») ;
- si le service a déjà disparu de Centreon, la règle est retirée (flash « service Centreon déjà absent ») ;
- si le **central est injoignable**, la règle reste en **« Suppression en attente »** (badge orange dans le tableau, tooltip = dernière erreur) et est **réessayée automatiquement** dès que le central répond (ou en re-cliquant Supprimer).

**Hôte orphelin** : si l'hôte Centreon a été **créé par Prox4u** (provisionnement automatique) et que la règle supprimée était la **dernière** à le cibler, l'hôte est **aussi supprimé** — à condition qu'**aucun autre service** n'y reste (les sondes ajoutées à la main par l'admin Centreon sont préservées) — flash « Règle supprimée — service et hôte Centreon supprimés (orphelin) ». Un hôte **créé directement dans Centreon** par l'administrateur n'est **jamais** supprimé par Prox4u. Un **balayage périodique** (toutes les 30 min par défaut) nettoie au passage les hôtes orphelins laissés par un échec de suppression (central injoignable).

![Règles de surveillance actives — tableau des règles](/screenshots/alarms.png)

---

## Règles d'alarme capteurs (SMART / température / systemd / ZFS)

En plus des métriques VM / nœud / cluster (API Proxmox), vous pouvez créer des règles sur les **capteurs locaux des nœuds**, collectés par l'agent **Telegraf** (base InfluxDB) :

| Métrique | Ce qu'elle surveille | Cible (nœud + identifiant) |
|---|---|---|
| **Température SMART** (`smart_temp_c`) | température d'un disque (°C) | disque (ex. `nvme0n1`) |
| **Santé SMART** (`smart_health`) | santé SMART (PASSED / FAILED) | disque |
| **Température capteur** (`sensor_temp_c`) | température CPU / mémoire (lm-sensors) | puce + feature (ex. `amdgpu-pci-0300` / `junction`) |
| **Unité systemd** (`systemd_unit_failed`) | unité en échec | unité (ex. `openipmi.service`) |
| **Pool ZFS** (`zfs_pool_state`) | état d'un pool (ONLINE / DEGRADED…) | pool (ex. `local-zpool`) |

**Comment ça marche** :
- Ces règles lisent **InfluxDB** (agent Telegraf), **pas** l'API Proxmox → elles fonctionnent **même si l'endpoint Proxmox est injoignable**.
- **Seuil effectif** : pour la température capteur, le seuil appliqué est le **seuil effectif** (seuil personnalisé ≤ seuil firmware, réglé dans **Administration → Seuils capteurs**) — la règle suit l'onglet admin (le seuil saisi dans la règle n'est utilisé que si aucun seuil n'est défini pour le capteur).
- **Inconnu ≠ dégradé** : si la cible est inconnue (unité introuvable, pool absent, disque sans SMART), la règle n'alerte **pas** (pas de faux positif).
- **Pool ZFS** : l'état des pools est fourni par le script Telegraf `prox4u-telegraf-zpool.sh` (déploiement `60-telegraf-nodes.sh`) — **l'agent doit être déployé sur le nœud** pour que la règle pool ZFS fonctionne.

> Exemple : règle « Température SMART » sur le nœud `proxmox`, disque `nvme0n1`, condition `> 45 °C`, sévérité WARNING → alarme Centreon si le disque dépasse 45 °C, récupération quand il repasse en dessous.

---

## Ce qui se passe en fond

Prox4u tourne un **moteur d'alarme** qui, toutes les **15 secondes**, évalue les règles actives :

| Événement | Quand | Ce qui est envoyé à Centreon |
|---|---|---|
| **Alerte** | la condition tient sur toute la fenêtre de confirmation | trame avec le code de sévérité (WARNING=1, CRITICAL=2) |
| **Récupération** | la condition n'est plus vraie | trame OK (code 0) |
| **Heartbeat OK** | toutes les `okHeartbeatSeconds` (défaut **300 s**) | trame OK (0) pour chaque règle saine |
| **Check hôte** | toutes les `hostCheckSeconds` (défaut **60 s**) | état de l'hôte dérivé de Proxmox (VM running→UP, stopped→DOWN…) |

- **L'alerte est immédiate** (dès que la fenêtre de confirmation est remplie) ; le heartbeat et le check hôte sont **périodiques** et servent à ce que les checks passifs Centreon ne restent pas à l'état `Pending`.
- Le **heartbeat OK n'est jamais envoyé si la règle est en alerte** (il ne masque pas une alerte en cours).
- Le **check hôte** sort l'hôte Centreon de `Pending` **sans commande de check active** (l'état est déduit de Proxmox).
- `okHeartbeatSeconds` / `hostCheckSeconds` = **0** → désactivé.

**Flux** : snapshot Proxmox (poller) → moteur d'alarme (ring-buffer en mémoire) → `send_nsca` → daemon NSCA du poller → Centreon. Pour les **règles capteurs**, la source est InfluxDB (agent Telegraf, lecture 1×/min partagée) au lieu du snapshot Proxmox — le reste du flux est identique.

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Module actif / non | Admin → Centreon (NSCA) | désactivé |
| Transport provisioning | Admin → Centreon (NSCA) | CLAPI (SSH) |
| Serveur NSCA + port + mdp | Admin → Centreon (NSCA) / `.env` | — |
| Pollers (nom + IP) | Admin → Centreon (NSCA) | Linux / Windows / Infra |
| `okHeartbeatSeconds` | Admin → Centreon (NSCA) | 300 (0 = off) |
| `hostCheckSeconds` | Admin → Centreon (NSCA) | 60 (0 = off) |
| Mapping VM → hôte | Admin → Centreon (NSCA) | auto-suggestion (hostname → VM) |
| Fenêtre de confirmation | formulaire de règle | à définir par règle |

---

## Limites connues

- **Transport REST v1** : cible la nouvelle API Centreon (`/api/latest/` + `X-AUTH-TOKEN`) — refait en issue #13, validé en conditions réelles. CLAPI reste disponible en alternative.
- **`send_nsca`** doit être installé sur le serveur Prox4u (`apt install nsca-client`), sinon « send_nsca indisponible ».
- **Service non déployé** : les trames sont rejetées si le service Centreon n'a pas été déployé (génération + `CFGMOVE`). Le provisioning fait cette étape automatiquement.
- **Quorum par endpoint** : la règle de quorum est par cluster Proxmox (pas de vmid / nœud).

---

## FAQ / dépannage

**Le service Centreon reste à `Pending` ?**
Activez le check hôte (`hostCheckSeconds` > 0) et/ou le heartbeat OK (`okHeartbeatSeconds` > 0) : un check passif n'a pas de check actif qui le rafraîchit.

**Aucune alarme ne part ?**
1. Le module est-il **activé** (Admin → Centreon) ?
2. Le **mapping VM → hôte** est-il renseigné ?
3. Le service Centreon est-il **provisionné + déployé** (colonne « Provisionning » = OK) ?
4. `send_nsca` est-il installé sur le serveur Prox4u ?
5. Le **mot de passe NSCA** est-il correct (`.env` ou Page 3) ?

**Une alerte est-elle en cours ?**
La règle affiche son état (ok / alerte) dans le tableau. En cas d'échec d'envoi, le statut « Transmission » passe en **erreur** avec un message — la règle reste enregistrée, rien ne crash.

**Comment tester sans attendre une vraie alerte ?**
Action **Tester** sur une règle : envoie une trame de test vers Centreon.

**Une règle capteur (SMART / température / systemd / ZFS) n'alerte pas ?**
1. L'**agent Telegraf** est-il déployé sur le nœud (`60-telegraf-nodes.sh`) ? La règle **pool ZFS** exige aussi le script `zpool` (déployé avec l'agent).
2. La **cible** correspond-elle exactement à l'identifiant (disque `nvme0n1` sans `/dev/`, puce + feature, nom d'unité, nom de pool) ? Une cible inconnue ne déclenche jamais (pas d'erreur, pas de faux positif).
3. Pour la **température capteur**, le **seuil effectif** (Administration → Seuils capteurs) est-il bien en dessous de la température courante ? C'est lui qui prime sur le seuil saisi dans la règle.
