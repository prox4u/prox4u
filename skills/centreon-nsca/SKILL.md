---
name: centreon-nsca
description: Plugin « Alarmes & Centreon » (famille centreon-nsca) — règles de surveillance sur VMs/nœuds/clusters Proxmox (dont quorum cluster via métrique cluster_quorum + Qdevice via cluster_qdevice + cible kind=cluster), engine d'évaluation (tick 15 s), provisioning du service passif Centreon via CLAPI (SSH/local) ou API REST v1, envoi des trames send_nsca, **trames périodiques : heartbeat OK services (okHeartbeatSeconds, code 0 pour les règles saines) + check hôte PROCESS_HOST_CHECK_RESULT (hostCheckSeconds, état dérivé de Proxmox — sort les hôtes/services de `Pending`)**, mapping VM→hôte Centreon (ajout manuel), pollers avec IP (destination NSCA), page de config admin, et **procédure user Centreon de monitoring non-admin validée 26.10** (§4.2 : mdp / ressources+actions / **topologies menu** / centAcl.php — gotchas : 500 login si contact_password NULL, pas d'API access groups). Use when working on the centreon-nsca plugin, /api/alarms/*, the alarm engine, NSCA frames, the OK heartbeat / host check periodic frames, Centreon provisioning, the /alarms pages, the cluster quorum/qdevice alarm, the « Centreon (NSCA) » admin tab, or creating a non-admin Centreon monitoring user.
---

# Centreon NSCA — Alarmes & Centreon

> 📖 **Notice utilisateur** : module « Documentation » de l'app — route `/docs/centreon-nsca`, source `packages/web/src/plugins/docs/content/centreon-nsca.md`.

Module qui transforme des **règles de surveillance** sur les VMs/nœuds/clusters Proxmox en **alarmes** transmises à **Centreon** sous forme de **checks passifs NSCA** (`send_nsca`). Cible : managers/DSI qui définissent des seuils, et le NOC Centreon qui reçoit les statuts.

> Un futur backend **Zabbix** partagera le namespace `/api/alarms/*` et le store sans toucher à cette famille. Le transport runtime NSCA est imposé ; le provisioning (création du service Centreon) peut passer par **CLAPI** ou **REST v1** (choix sur la page de config).

## 1. Périmètre & routes

| Surface | Où | Rôle |
|---|---|---|
| `/alarms` | `pages/rules.tsx` | **Page 2** — tableau des règles : filtres (texte/poller/état/provisionnement), recherche globale, tri, indicateurs, actions (activer/désactiver, modifier, supprimer, **Tester**, **Reprovisionner**) |
| `/alarms/new` | `pages/create-rule.tsx` | **Page 1** — formulaire de création → provisionne le service Centreon puis enregistre la règle + récap provisioning |
| `/alarms/edit/:id` | `pages/edit-rule.tsx` | Édition (même formulaire, ne re-provisionne pas) |
| Admin → onglet « Centreon (NSCA) » | `components/admin/nsca-config.tsx` | **Page 3** — activation du module, transport CLAPI/REST, central, pollers (nom + IP), NSCA, **trames périodiques (heartbeat OK + check hôte)**, mapping VM→hôte (+ bouton Ajouter) |
| API | `GET/POST /api/alarms/*` | règles, cibles (VMs/nœuds/clusters), config, test, provisioning |
| Engine | `engine.ts` | tick 15 s, évaluation des règles actives, trames aux transitions **+ trames périodiques (heartbeat OK services + check hôte)** |

Feature flag : `VITE_USE_PLUGIN_CENTREON_NSCA` (défaut ON, opt-out). Famille `centreon-nsca` (pas de versionnement `_vN` — premier module de la famille).

## 2. Arborescence du code

```
packages/shared/src/centreon-nsca.ts         # types + fonctions pures (testées)
packages/shared/src/centreon-nsca.test.ts    # 32 tests (échappement, trame service+hôte, évaluation…)
packages/server/src/modules/centreonnsca/
  index.ts     # registerAlarmNsca (store + engine + routes)
  store.ts     # NscaStore — data/centreon-nsca.json (seed, CRUD, stats)
  metrics.ts   # extraction de la valeur d'une métrique (VmSummary/NodeHealth/cluster)
  engine.ts    # AlarmEngine — tick 15 s, machine à états, envoi NSCA
  nsca.ts      # send_nsca (cfg généré, spawn, timeout, jamais de mdp loggué)
  provision.ts # CLAPI (ssh/local) + REST v1 (création service + déploiement)
  routes.ts    # /api/alarms/* (règles, cibles, config, test, provisioning)
  store.test.ts routes.test.ts               # 20 tests serveur
packages/web/src/plugins/centreon-nsca/
  index.ts     # manifest (3 routes + 1 menu, icône Siren, order 60)
  lib/nsca-api.ts   # client API /api/alarms/*
  lib/types.ts      # MetricIdList
  pages/{rules,create-rule,edit-rule}.tsx
  components/rule-form.tsx   # formulaire (auto-suggestion hôte + service)
packages/web/src/components/admin/nsca-config.tsx  # Page 3 (onglet admin)
```

## 3. Données

- **Store** : `data/centreon-nsca.json` (gitignoré, chmod 600, écriture atomique) — `{ version, config, pollers[], mappings[], rules[] }`. Seed au 1ᵉʳ démarrage : module **désactivé**, pollers par défaut (Linux/Windows/Infra), aucune règle.
- **Mesures source** : snapshot poller (`VmSummary` : cpuPct, mem/maxmem, disk/maxdisk, status, uptimeSec, netIn/Out, ipAddresses ; `NodeHealth` : cpuPct, ramPct, diskPct, online, uptimeSec ; `cluster` : quorum, quorumState). L'engine tient un **ring-buffer en mémoire** par règle (pas de dépendance InfluxDB) — fonctionne en mock et en réel.
- **Métriques** : VM = cpu_pct, ram_pct, disk_pct, vm_status, ip_reachable, uptime_sec, net_in_bps, net_out_bps · Nœud = node_cpu_pct, node_ram_pct, node_disk_pct, node_online · **Cluster = cluster_quorum, cluster_qdevice** (cible `kind: 'cluster'` — quorum ok=1/perdu=0 ; Qdevice up/absent=1, down=0, unknown=null). Les statuts sont numérisés (1 = bon état, 0 = mauvais). Service auto-nommé `Prox4u-Alarm-CLUSTER-QDEVICE`.
- **Cible cluster (quorum)** : `AlarmTarget.kind = 'vm' | 'node' | 'cluster'`. Le quorum est **par endpoint** (= par cluster Proxmox) ; la règle n'a ni vmid ni node, juste endpointId + label (nom du cluster). Le quorum est collecté par `getNodes()` (entrée cluster de `/cluster/status` : `quorum` + `quorum_state` PVE 8+, sinon dérivé `en ligne < quorum → lost` via `deriveQuorumState` shared). Le mock force `quorumState: 'lost'` en scénario `critical` (chaîne complète testable).

## 4. Mécanisme imposé (runtime + provisioning)

### 4.1 Runtime — send_nsca
- L'app **génère** `data/nsca/send_nsca.cfg` (chmod 600) depuis la config (serveur, port, encrypt, mot de passe) puis : `printf '<host>\t<svc>\t<code>\t<output>\n' | send_nsca -H <server> -c <cfg>`.
- **Destination NSCA** : l'IP du poller cible si renseignée (`CentreonPoller.ip`), sinon le serveur NSCA du central (`config.nsca.server`). Chaque poller peut ainsi avoir son propre daemon NSCA.
- Trame **service** construite par `buildNscaFrame` (shared) : 4 champs `host\tsvc\tcode\toutput`, les champs hôte/service **échappés** (`;`→`\;`, `\n`→`\n` littéral, tab→espace) contre l'injection.
- Trame **hôte** construite par `buildNscaHostFrame` (shared) : 3 champs `host\tcode\toutput` **sans le service** (format documenté nsca-ng : « host check results … just without the service description ») → le daemon en génère un `PROCESS_HOST_CHECK_RESULT`.
- `output` = template `{{vm}} {{metric}} {{value}} {{threshold}}` rendu par `renderOutput` (services) ; output factice dérivé de l'état Proxmox (check hôte).
- Return code : 0=OK (récupération / heartbeat / UP), 1=WARNING / DOWN, 2=CRITICAL, 3=UNKNOWN (`nscaReturnCode`).

### 4.2 Provisioning — CLAPI **ou** REST v1 (choix Page 3)
Paramètres du service passif (les deux transports) : `passive_checks_enabled=1`, `active_checks_enabled=0`, `is_volatile=1`, `max_check_attempts=1`, `check_command=check_dummy!0` (factice, jamais exécutée).
- **CLAPI** : `centreon -u <u> -p <pass> -o SERVICE -a add -v "<host>;<svc>"` + `setparam` ×5, puis `POLLERGENERATE -v "<poller>"` + `CFGMOVE -v "<poller>"`. Séquence testée dans shared (`clapiProvisionCommands`). **Mode SSH** (Prox4u hors central — nominal) : `ssh <u>@<host> "centreon …"` ; **mode local** si Prox4u est sur le central. Le mot de passe est injecté **sur stdin** (`-p "$(cat)"`) → jamais dans l'argv (ps) ni loggué.
- **REST v1** : token d'API Centreon sur la **nouvelle API** `/api/latest/`, en-tête **`X-AUTH-TOKEN`** (pas Basic auth) : ressources `/configuration/hosts`, `/configuration/services`, `/configuration/pollers`, `/configuration/commands`. ⚠ **À refondre** : le code actuel (`provision.ts`) cible encore `/api/restapi/` + Basic auth (user:token) — chemin + auth + formats d'input à aligner sur la nouvelle API (cf. §7).

**Compte + token + NSCA + user monitoring** : le script du kit `deploiement/70-centreon-setup.sh` (DEPLOY.md §11) prépare le central — **CLAPI d'abord** : groupe `groupeprox4u` (CLAPI `ACLGROUP`) + compte `prox4u` (**admin global**) ; **token API** (SQL `security_token` + `security_authentication_tokens` — **seul accès DB**, pas d'équivalent CLAPI) ; mdp **NSCA** écrit dans `nsca.cfg` **sur le central** (cible NSCA = IP machine du central, **pas de liste DB des pollers**) ; **user de monitoring non-admin** (console, §4.2 ci-dessous — variables `MON_USER_LOGIN`/`MON_USER_EMAIL`/`MON_GROUP`/`MON_TOPO_NAME`, mdp saisi, **vide = sauté**). Idempotent, `--dry-run`/`--remove`/`--rotate-token`/`--rotate-nsca`/`--token-only`, interactif (l'admin saisit les crédos), auto-vérif + récap Page 3. Accès DB : env `DB_USER/DB_PASS` > `centreon.conf.php`/`centreon` > root via socket unix > prompt.

> ⚠️ **Admin global OBLIGATOIRE pour la nouvelle API** (gotcha validé sur Centreon 26.10) : sans le flag admin, la nouvelle API `/api/latest/` renvoie **403 « pas la permission »** sur TOUTES les ressources, même avec un token valide. Le flag se pose via CLAPI `CONTACT -a setparam -v "<alias>;admin;1"` — **le paramètre CLAPI s'appelle `admin`, PAS `contact_admin`** (c'est le nom de la colonne DB ; `setparam …;contact_admin;1` est silencieusement inefficace). Le script l'applique dans les 2 branches (créé/existe) + l'auto-vérif teste `/api/latest/configuration/hosts` (200 = OK, 403 = flag admin à 0, 401 = token invalide).
>
> ⚠️ **API legacy `/api/restapi` SUPPRIMÉE en 26.10** (404 HTML) : le transport REST v1 de l'app (`provision.ts`, Basic auth `user:token` sur `/api/restapi/*`) ne fonctionne plus → c'est le sujet de l'**issue #8** (refonte sur `/api/latest/` + `X-AUTH-TOKEN`). Le NSCA (TCP 5668), lui, est indépendant de l'API.

**Token seul** : `70-centreon-setup.sh --token-only` (DEPLOY.md §11.4) ne touche **qu'au token** (pas de groupe/compte/NSCA), **non-interactif** (seul l'accès DB est requis, pas d'identifiants admin) — à exécuter en root sur le central, suppose le compte `prox4u` existant. Combinable avec `--rotate-token` (régénérer) / `--remove` (supprimer) / `--dry-run`. Même logique d'insertion SQL (schéma 21.10+ `security_token` + `security_authentication_tokens`, fallback table `token` ≤ 20.x) + auto-vérif `/api/latest/` + `X-AUTH-TOKEN`. Cas d'usage : token perdu/compromis → `--token-only --rotate-token` puis reporter dans le `.env`.

**Secrets via `.env` du serveur Prox4u** (DEPLOY.md §11.3) : le token REST, le mdp NSCA et le mdp CLAPI se posent dans le `.env` du serveur (`CENTREON_REST_TOKEN`, `CENTREON_NSCA_PASSWORD`, `CENTREON_CLAPI_PASSWORD`) — ils **prévalent** sur les valeurs de `data/centreon-nsca.json` (saisie UI Page 3). Le store (`NscaStore.getConfig()`) merge la prévalence env au read ; `envSecretFlags()` expose à l'UI quels secrets viennent du `.env` (hint « Fourni via .env »). Les champs non-secrets (URL, user, hôte, port) restent en UI. Le script setup affiche les lignes `.env` à copier-coller dans son récap.

**Enchaînement imposé** : création du service → génération de config → déploiement (`POLLERGENERATE`/`CFGMOVE` ou `config/generate`+`config/move`). Un service passif ne reçoit des trames NSCA qu'après déploiement.

**User Centreon de monitoring (non-admin) — procédure validée 26.10** (débogage E2E 25/11, compte de test) : pour qu'un user voie les hosts/services dans la console **sans être admin**, le groupe ACL doit avoir **3 dimensions** : **ressources** (quels hosts/services), **actions** (ce qu'on peut faire), **topologies** (quelles pages de menu). L'une des trois manquante = accès incomplet :
1. **Créer le user AVEC mot de passe** (UI : Administration → Users → Add). ⚠️ Un user sans ligne `contact_password` (créé sans mdp, ou avec seulement une autologin key) → **500 au login** (pas un 401) : `password_verify($mdp, null)` / `str_starts_with(null, …)` lève une exception PHP 8 dans `centreonAuth.class.php`, attrapée par le `catch (\Throwable)` du use case `Login` → `ErrorResponse`. Diagnostic : `SELECT * FROM contact_password WHERE contact_id=<id>;` (vide = cause). Correction : `INSERT INTO contact_password (password, contact_id, creation_date) VALUES ('<php -r "echo password_hash(…)">', <id>, UNIX_TIMESTAMP());`
2. **Ressources + actions** : le groupe **ALL** (id 1) existe par défaut avec ressource `All Resources` (`all_hosts=1`, `all_hostgroups=1`) + action **Simple User** (vision monitoring hosts+services) — c'est le rattachement « vision sur tout, pas admin » (`contact_admin` reste 0 ; un admin bypass les ACL).
3. **Topologies (accès menu) — LA pièce souvent manquante** : sans topologie rattachée au groupe, le menu de l'user est vide (`centreon_topology&action=navigationList` = `null`) → **toutes les pages** affichent « Perdu(e) dans l'espace ? Vous n'avez pas la permission de voir cette page » (les compteurs du haut, eux, marchent car `top_counter` est une permission séparée). En 26.10 les tables `acl_topology` / `acl_topology_relations` / `acl_group_topology_relations` sont **vides par défaut** (aucun groupe de menu pré-créé). UI : Access Groups → groupe → onglet **Topologies** → créer/sélectionner « Monitoring » (lecture seule). Équivalent SQL (validé) :
   ```sql
   INSERT INTO acl_topology (acl_topo_name, acl_topo_alias, acl_comments, acl_topo_activate)
   SELECT 'Monitoring','Monitoring','Menu Monitoring (vision, lecture seule)','1'
   WHERE NOT EXISTS (SELECT 1 FROM acl_topology WHERE acl_topo_name='Monitoring');
   SET @topo_id=(SELECT acl_topo_id FROM acl_topology WHERE acl_topo_name='Monitoring');
   INSERT INTO acl_topology_relations (acl_topo_id, topology_topology_id, access_right)
   SELECT @topo_id, topology_id, 2 FROM topology WHERE topology_page LIKE '2%'
     AND topology_id NOT IN (SELECT topology_topology_id FROM acl_topology_relations WHERE acl_topo_id=@topo_id);
   INSERT INTO acl_group_topology_relations (acl_group_id, acl_topology_id)
   SELECT 1, @topo_id WHERE NOT EXISTS (SELECT 1 FROM acl_group_topology_relations
     WHERE acl_group_id=1 AND acl_topology_id=@topo_id);
   ```
   (`topology_page LIKE '2%'` = tout l'arbo du menu Monitoring — Resources Status `/monitoring/resources` (page `200`), Hosts, Services, Downtimes, Comments… ; `access_right` : 1=lecture/écriture, 2=**lecture seule**.)
4. **Recalcul des ACL** : `php /usr/share/centreon/cron/centAcl.php` (ou attendre le cron) — sinon le cache ACL est stale.

**Automatisé** : `deploiement/70-centreon-setup.sh` fait les 4 étapes (section « user monitoring », idempotente, **testée sur un central 26.10 réel**) — variables `MON_USER_LOGIN` (défaut `noc`) / `MON_USER_EMAIL` / `MON_GROUP` (défaut `ALL`) / `MON_TOPO_NAME` (défaut `Monitoring`) ; mdp saisi au setup (**vide = sauté**, **re-saisie en boucle si les 2 saisies ne correspondent pas** — plus de `die` sur un mauvais recopiage) ; `--remove` supprime le compte + le rattachement (la topologie est conservée, réutilisable). ⚠ Le `CLAPI add` renvoie 0 même si Centreon **refuse** (erreur dans le body JSON, ex. politique de mot de passe < 8 car.) → le script capture la réponse + vérifie la création en base (die avec l'erreur CLAPI sinon). → après une réinstallation Centreon, relancer le script = tout est en place **sans SQL manuel**.

> ⚠️ **Pas d'API pour rattacher un user à un access group en 26.10** (vérifié dans le source du tag `release-onprem-20261001-26.10`) : la nouvelle API n'expose que `GET /configuration/access-groups` (lecture seule, 1 controller `FindLocalUserAccessGroups`) ; l'objet CLAPI `ACL` ne garde que `reload`/`lastreload` (le `setparam` contacts est retiré) ; l'API legacy `/api/restapi` est supprimée. → **UI legacy** (Administration → Users → onglet Access Groups) ou **SQL** : `INSERT INTO acl_group_contacts_relations (contact_contact_id, acl_group_id) VALUES (<id>, 1); UPDATE acl_groups SET acl_group_changed=1 WHERE acl_group_id=1;` puis `centAcl.php`.
>
> ⚠️ **La « login key » = Autologin Key** (`contact_autologin_key`) : elle sert au flux d'autologin (embedding), **pas** au formulaire de login classique (autologin désactivé dans le flow API `CentreonAuth::AUTOLOGIN_DISABLE`). Le login normal utilise le mot de passe.
>
> **Vérification sans UI** : `GET /api/latest/monitoring/hosts` + `/monitoring/services` (token `X-AUTH-TOKEN`) → `state` 0=OK/UP, 1=WARNING, 2=CRITICAL, 4=Pending ; `state_type` 1=hard.

### 4.3 Engine — machine à états + trames périodiques
Tick 15 s, pour chaque règle active (module actif) : échantillonner la métrique → `evaluateAlarm` (la condition doit tenir sur **toute** la fenêtre de confirmation) → transitions **ok⇄firing** → trame à chaque transition (alarme = code sévérité, récupération = 0). L'état bascule **avant** l'envoi (transition consommée même si `send_nsca` échoue → pas de boucle). Échec = `lastSendState=error` + message, **aucun crash**.

**Trames périodiques** (config `okHeartbeatSeconds` / `hostCheckSeconds`, défauts 300/60, `0` = off) — ajoutées pour que les checks passifs Centreon ne restent pas à l'état `Pending` (un check passif n'a pas de check actif qui le rafraîchit) :
- **Heartbeat OK services** : pour chaque règle active dans l'état `ok`, une trame **OK (code 0)** est envoyée toutes les `okHeartbeatSeconds`. **Jamais envoyé si `state ≠ ok`** (ne masque pas une alerte en cours) — c'est la « règle saine » : une règle qui n'alerte jamais émet un code 0 périodique. La trame de **récupération** pose aussi `lastOkSendAt` (elle EST une trame OK → pas de double envoi au même tick). Suivi par règle : champ `AlarmRule.lastOkSendAt` (persisté). Log `alarm : OK heartbeat « … »`.
- **Check hôte** : pour chaque **hôte Centreon provisionné** (règles actives, dédoublonné par hôte), une trame `PROCESS_HOST_CHECK_RESULT` (3 champs, `buildNscaHostFrame`) toutes les `hostCheckSeconds`. L'état est **dérivé du target Proxmox** : VM running→0 / stopped→1 / introuvable→3 ; nœud online→0 / offline→1 ; quorum ok→0 / perdu→1 / inconnu→3 (`null` = endpoint indisponible → pas de trame, réessai au tick suivant). Suivi en **mémoire** par hôte (`hostLastSend`/`hostLastCode`) — log uniquement au **changement d'état** ou en **échec** (pas de spam). L'hôte Centreon sort de `Pending` **sans commande de check active** (l'erreur engine « no check command » devient sans impact).
- **Effet validé E2E (Centreon 26.10)** : hôte `ia-u24-01` → **UP** (state 0, output « UP — VM running (Proxmox) »), service CPU → **OK** (heartbeat), service IP → **CRITICAL** (alerte réelle `ip_reachable=0`). Vérifiable via l'API monitoring du central : `GET /api/latest/monitoring/hosts` + `/monitoring/services` (token `X-AUTH-TOKEN`) — `state` 0=OK/UP, 1=WARNING, 2=CRITICAL, 4=Pending ; `state_type` 1=hard.

## 5. Sécurité & robustesse (contraintes)
- **Mots de passe** CLAPI / NSCA / token REST : jamais loggués, jamais renvoyés en clair par l'API (masqués `••••••` à la relecture ; renvoyer le masque = « inchangé »). Stockés dans `data/centreon-nsca.json` (chmod 600, gitignoré).
- **Échappement** des `;` et retours à la ligne dans les noms d'hôte/service (injection trame NSCA impossible).
- **CLAPI/REST en échec** ou **send_nsca en échec** : la règle reste enregistrée, le statut provisioning/transmission passe en `erreur` + message. Aucun crash.
- Module **désactivé** (Page 3) = l'engine ne fait rien (pas d'envoi).

## 6. Décisions actées
- **Nom `centreon-nsca`** (pas `alarm-nsca`) : un backend Zabbix viendra plus tard, la famille sera généralisée. Namespace API `/api/alarms/*` volontairement générique.
- **CLAPI en SSH par défaut** : Prox4u n'est PAS sur le central Centreon. `clapiMode=ssh` est le nominal ; `local` conservé pour un déploiement sur le central.
- **Source des métriques = snapshot poller** (ring-buffer mémoire), pas InfluxDB : fonctionne en mock et en réel, sans dépendance, et la fenêtre de confirmation est évaluée sur les échantillons réels.
- **Mapping VM→hôte Centreon** : table configurable (auto-suggestion `suggestCenteronHost` = hostname→nom de VM, override manuel), upsertée à la création d'une règle.
- **Page 3 = onglet admin** « Centreon (NSCA) » (à côté de Catalogue/Groupes/Users), pas une route publique.

## 7. Pièges
- **Transport REST = nouvelle API** : la nouvelle API Centreon est servie sur `/api/latest/` (pas `/api/restapi/`, qui renvoie le fallback SPA 404) et s'authentifie par l'en-tête **`X-AUTH-TOKEN`** (pas Basic auth user:token). Les ressources sont `/configuration/hosts`, `/configuration/services`, `/configuration/pollers`, `/configuration/commands` (pas `/host`, `/service`, `/instance/poller`). Le token est stocké dans `security_token` + `security_authentication_tokens` (schéma 21.10+), pas dans l'ancienne table `token`. ⚠ Le `provision.ts` actuel cible encore l'ancien contrat → **à refondre** avant d'activer le transport REST en réel.
- **send_nsca absent** → le binaire doit être installé sur le serveur Prox4u (`apt install nsca-client` / `nsca`), sinon `send_nsca indisponible`. Le fichier `send_nsca.cfg` est généré automatiquement par l'app.
- **Service non déployé** → les trames sont rejetées par le daemon NSCA si le service n'a pas été `CFGMOVE`'d. Toujours enchaîner génération+déploiement.
- **`check_dummy!0`** est une commande factice (jamais exécutée, passive pur) — ne pas la remplacer par un vrai check.
- **Fenêtre de confirmation** : `evaluateAlarm` ne déclenche que si **tous** les échantillons de la fenêtre dépassent le seuil ; une fenêtre vide (pas de données) ne déclenche pas (la valeur passe en null).
- **Échappement** : `escapeNscaField` échappe d'abord les `\` puis `;`/`\n` — ne pas réordonner (sinon double-échappement).

## 8. Tests
- `packages/shared/src/centreon-nsca.test.ts` (32) : `nscaReturnCode`, `escapeNscaField` (`;`/`\n`/tab), `buildNscaFrame` (trame service 4 champs), `buildNscaHostFrame` (trame hôte 3 champs, sans service), `renderOutput`, `defaultServiceName`, `suggestCenteronHost`, `conditionMet`, `evaluateAlarm` (fenêtre), `nscaCfgContent`, `clapiProvisionCommands` (séquence exacte), `clapiDeleteCommand`.
- `packages/server/src/modules/centreonnsca/store.test.ts` (13) : seed, persistance, CRUD règles (dont `lastOkSendAt`), setConfig (normalisation `okHeartbeatSeconds`/`hostCheckSeconds`), setPollers (slug+dédup), upsertMapping, stats 24 h.
- `packages/server/src/modules/centreonnsca/routes.test.ts` (10) : GET/POST/PATCH/DELETE règles, validation 400, nom en double 409, test, provision, PUT config (masquage mdp + « inchangé »).
- `packages/server/src/modules/centreonnsca/provision.test.ts` (10) : séquence CLAPI + REST v1.

## 9. Exemples de trame & commande (livrable)
- Trame générée : `vm-web-01\tProx4u-Alarm-CPU\t2\tvm-web-01 CPU 94% (seuil 90%)\n`
- Commande CLAPI de création : `centreon -u clapi -p "$(cat)" -o SERVICE -a add -v "vm-web-01;Prox4u-Alarm-CPU"` (suivi des `setparam` + `POLLERGENERATE`/`CFGMOVE`).
- Script de test manuel : `scripts/nsca-test.sh` (envoie une trame vers un NSCA de test + vérifie le statut dans Centreon).
