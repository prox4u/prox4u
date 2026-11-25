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

### 2. Créer une règle d'alarme

1. Ouvrez **Alarmes & Centreon → Nouvelle règle**.
2. Choisissez :
   - la **cible** : une VM, un nœud, ou un cluster (quorum / Qdevice) ;
   - la **métrique** : CPU, RAM, disque, statut VM, IP joignable, uptime, réseau, en ligne nœud, quorum… ;
   - la **condition** : seuil (ex. CPU > 90 %), sens (supérieur / inférieur), sévérité (WARNING / CRITICAL) ;
   - la **fenêtre de confirmation** : la condition doit tenir sur toute la fenêtre avant d'alerter (évite les à-coups).
3. Enregistrez : Prox4u **provisionne le service Centreon** (service passif), puis enregistre la règle.

### 3. Gérer les règles

Dans **Alarmes & Centreon**, le tableau liste toutes les règles avec :
- filtres (texte, poller, état, provisioning) et recherche ;
- actions : **activer / désactiver**, **modifier**, **supprimer**, **Tester** (envoie une trame de test), **Reprovisionner** (recrée le service Centreon).

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

**Flux** : snapshot Proxmox (poller) → moteur d'alarme (ring-buffer en mémoire) → `send_nsca` → daemon NSCA du poller → Centreon.

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

- **Transport REST v1** : le code actuel cible encore l'ancienne API Centreon (`/api/restapi/` + Basic auth), supprimée en 26.10. À refondre sur la nouvelle API (`/api/latest/` + `X-AUTH-TOKEN`) — cf. issue #8. **Utilisez CLAPI en attendant.**
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
