---
name: centreon-nsca
description: Plugin « Alarmes & Centreon » (famille centreon-nsca) — règles de surveillance sur VMs/nœuds/clusters Proxmox (dont quorum cluster via métrique cluster_quorum + Qdevice via cluster_qdevice + cible kind=cluster), **règles d'alarme capteurs (GitHub #4) : 5 métriques smart_temp_c / smart_health / sensor_temp_c / systemd_unit_failed / zfs_pool_state lues dans InfluxDB raw (agent Telegraf des nœuds — fonctionne même si l'endpoint PVE est injoignable), cible kind=node + identifiant (device/chip/feature/unit/pool), seuil EFFECTIF perso ≤ firmware pour sensor_temp_c (onglet « Seuils capteurs »), SensorDataCache 60 s, inconnu = null (jamais de faux OK), table zpool via script exec Telegraf**, **engine d'évaluation v2 (tick 15 s) : hystérésis (seuil de récupération distinct → zone morte anti-flapping) + durée minimale de firing (suppression) + ack (marqueur, ne coupe pas les trames) + auto-résolution (récup clear l'ack) — GitHub #5**, provisioning du service passif Centreon via CLAPI (SSH/local) ou API REST v1 (**`/api/latest/` + `X-AUTH-TOKEN` — refait en issue #13**), **suppression cohérente Prox4u↔Centreon (GitHub #20) : la route DELETE retire le service Centreon AVANT la règle — `deleted`/`not-found` → règle retirée, central injoignable → règle en « suppression en attente » (`pendingDeletion`) + réessai automatique (engine, throttle 60 s) + re-cliquer Supprimer, badge UI orange + flash, filtre `filter[name]` (seul paramètre fonctionnel de l'API — `name`/`host_id` ignorés)**, **gestion des orphelins d'hôtes (GitHub #21) : `managedHosts` (hôtes auto-créés par Prox4u en REST — `hostCreated`), suppression de règle → l'hôte est supprimé s'il devient orphelin (3 garde-fous cumulés : `managedHosts` + aucune règle ne le cible + 0 service restant — les sondes admin sont préservées), `hostDeleted` + flash « service et hôte supprimés », réessai automatique + balayage périodique (config `orphanSweepMinutes`, défaut 30 min, 0=off, tourne module désactivé)**, envoi des trames send_nsca (toujours aux transitions réelles + heartbeat), **trames périodiques : heartbeat OK services (okHeartbeatSeconds, code 0 pour les règles saines) + check hôte PROCESS_HOST_CHECK_RESULT (hostCheckSeconds, état dérivé de Proxmox — sort les hôtes/services de `Pending`)**, mapping VM→hôte Centreon (ajout manuel), pollers avec IP (destination NSCA), page de config admin, et **procédure user Centreon de monitoring non-admin validée 26.10** (§4.2 : mdp / ressources+actions / **topologies menu** / centAcl.php — gotchas : 500 login si contact_password NULL, pas d'API access groups), et **validation E2E central réel 2026-11-27 (GitHub #1, clôturé) : passe UI Playwright 13/13 (login → onglet admin secrets masqués → tableau règles → création règle capteur → Tester/Reprovisionner/Désactiver/Activer/Supprimer) + check sécurité (0 secret dans logs/API) — sans CLAPI** (§10). Use when working on the centreon-nsca plugin, /api/alarms/*, the alarm engine (v2 hysteresis/suppression/ack), the sensor alarm rules (SMART / temperature / systemd / ZFS, effective thresholds, /api/alarms/targets sensors section), NSCA frames, the OK heartbeat / host check periodic frames, Centreon provisioning, the /alarms pages, the cluster quorum/qdevice alarm, the « Centreon (NSCA) » admin tab, or creating a non-admin Centreon monitoring user.
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
packages/shared/src/centreon-nsca.test.ts    # 69 tests (échappement, trame service+hôte, évaluation, hystérésis v2, métriques capteurs v1 #4, clapiDeleteCommands #20, clapiDeleteHostCommands #21…)
packages/server/src/modules/centreonnsca/
  index.ts     # registerAlarmNsca (store + engine + routes + SensorDataCache)
  store.ts     # NscaStore — data/centreon-nsca.json (seed, CRUD, stats, managedHosts #21)
  metrics.ts   # extraction de la valeur d'une métrique (VmSummary/NodeHealth/cluster)
  engine.ts    # AlarmEngine — tick 15 s, machine à états, envoi NSCA (+ échantillonnage capteurs + réessai suppressions en attente #20 + balayage orphelins #21)
  nsca.ts      # send_nsca (cfg généré, spawn, timeout, jamais de mdp loggué)
  provision.ts # CLAPI (ssh/local) + REST v1 /api/latest/ (création service+hôte + déploiement + SUPPRESSION service #20 + SUPPRESSION hôte orphelin #21 + comptage services hôte)
  orphan.ts    # tryDeleteOrphanHost — 3 garde-fous cumulés + suppression hôte (partagé route DELETE + engine retry + sweep #21)
  routes.ts    # /api/alarms/* (règles, cibles + section sensors, config, test, provisioning, ack/unack v2, DELETE cohérent service+hôte orpheline #20/#21)
  sensor-data.ts # SensorDataCache — TTL 60 s, 1 fetchSensorAlarmData/min partagé (GitHub #4)
  store.test.ts routes.test.ts engine.test.ts provision.test.ts # 119 tests serveur (dont engine v2 + capteurs + suppression #20 + orphelins #21)
packages/web/src/plugins/centreon-nsca/
  index.ts     # manifest (3 routes + 1 menu, icône Siren, order 60)
  lib/nsca-api.ts   # client API /api/alarms/*
  lib/types.ts      # MetricIdList
  pages/{rules,create-rule,edit-rule}.tsx
  components/rule-form.tsx   # formulaire (auto-suggestion hôte + service)
packages/web/src/components/admin/nsca-config.tsx  # Page 3 (onglet admin)
```

## 3. Données

- **Store** : `data/centreon-nsca.json` (gitignoré, chmod 600, écriture atomique) — `{ version, config, pollers[], mappings[], rules[], managedHosts[] }`. Seed au 1ᵉʳ démarrage : module **désactivé**, pollers par défaut (Linux/Windows/Infra), aucune règle. **`managedHosts` (GitHub #21)** : liste des hôtes Centreon **auto-créés par Prox4u** (`{ host, pollerId }[]`) — seuls ces hôtes sont éligibles à la suppression orpheline ; un hôte créé à la main par l'admin n'y figure jamais. Migration `init()` : champ absent → `[]`.
- **Mesures source** : snapshot poller (`VmSummary` : cpuPct, mem/maxmem, disk/maxdisk, status, uptimeSec, netIn/Out, ipAddresses ; `NodeHealth` : cpuPct, ramPct, diskPct, online, uptimeSec ; `cluster` : quorum, quorumState). L'engine tient un **ring-buffer en mémoire** par règle (pas de dépendance InfluxDB) — fonctionne en mock et en réel. **Exception : les métriques capteurs lisent InfluxDB raw** (agent Telegraf des nœuds) — cf. §3.1.
- **Métriques** : VM = cpu_pct, ram_pct, disk_pct, vm_status, ip_reachable, uptime_sec, net_in_bps, net_out_bps · Nœud = node_cpu_pct, node_ram_pct, node_disk_pct, node_online · **Capteurs (GitHub #4) = smart_temp_c, smart_health, sensor_temp_c, systemd_unit_failed, zfs_pool_state** (cible `kind: 'node'` + identifiant) · **Cluster = cluster_quorum, cluster_qdevice** (cible `kind: 'cluster'` — quorum ok=1/perdu=0 ; Qdevice up/absent=1, down=0, unknown=null). Les statuts sont numérisés (1 = bon état, 0 = mauvais). Service auto-nommé `Prox4u-Alarm-CLUSTER-QDEVICE`.

### 3.1 Métriques capteurs (GitHub #4) — source InfluxDB raw

- **Pourquoi InfluxDB raw et pas le snapshot poller** : les capteurs (SMART, lm-sensors, ZFS, systemd) ne sont collectés que par l'agent Telegraf des nœuds → disponibles dans la base `raw` ; le snapshot poller (API PVE) ne les contient pas. Conséquence : **les règles capteurs fonctionnent même si l'endpoint PVE est injoignable** (pas de retour anticipé endpoint-down pour ces métriques).
- **Fonctions pures (shared `centreon-nsca.ts`)** : `sensorMetricValue(data, target, metric)` → `1 | 0 | null` — **null = inconnu, jamais de faux OK** (unité absente de la liste des unités, pool absent, SMART healthOk null, température SMART 0 °C) ; `resolveSensorThresholds(rule, data, thresholds)` → `{ threshold, recoveryThreshold }` : pour `sensor_temp_c` le **seuil effectif** (perso ≤ firmware, `effectiveSensorThreshold`) **remplace** le seuil de la règle (repli : seuil de la règle si aucun seuil défini pour le capteur) + cohérence hystérésis (recoveryThreshold du mauvais côté du seuil effectif → repli sur le seuil de déclenchement) ; `sensorTargetFields(metric)` / `isSensorMetric(metric)` (validation + UI) ; `SENSOR_METRICS` (liste des 5).
- **Cibles** : `AlarmTarget` étendu `device?` (SMART) / `chip?` + `feature?` (lm-sensors) / `unit?` (systemd) / `pool?` (ZFS) — toujours `kind='node'` + `node` + l'identifiant ; validation serveur 400 `bad-sensor-target` / `fields`.
- **Source de données (server)** : `nodesensors/data.ts` → `fetchSensorAlarmData(ctx)` — 6 requêtes InfluxDB raw (fenêtre 1 h, dernier point par cible) : SMART (`smart_device`), capteurs (`sensors`), ZFS ARC (`zfs`), **pools ZFS (table `zpool`)**, unités en échec (`systemd_units` active=failed/load=error), **TOUTES les unités** (sans filtre — distingue « saine » de « inconnue »). **try/catch par section** : une section indisponible (ex. table `zpool` absente) ne casse pas les autres (warn loggué). `nodesensors/routes.ts` est refactored dessus (page `/api/node-sensors` inchangée).
- **Cache moteur** : `sensor-data.ts` → `SensorDataCache` (TTL 60 s) — **1 lecture InfluxDB/min partagée** par toutes les règles capteurs (l'engine appelle `sensorCache.get()` à chaque tick ; le cache rafraîchit au-delà du TTL).
- **Seuils perso** : `SensorThresholdStore` partagé (module `nodesensors`, `ctx.sensorThresholds`, créé dans `index.ts`) — le moteur lit `getThresholds()` **à chaud** à chaque tick (pas de cache) ; les seuils sont gérés dans l'onglet admin « Seuils capteurs » (`GET/PUT/DELETE /api/admin/sensor-thresholds`, **admin-only**).
- **Table `zpool`** : le plugin zfs de Telegraf ne collecte PAS l'état des pools (ARC + counters I/O optionnels uniquement, pas de champ `state`) → **script exec `prox4u-telegraf-zpool.sh`** (`zpool status -p -H -o name,state` → line protocol `zpool,pool=<nom> state="<état>"`) installé par `deploiement/60-telegraf-nodes.sh` (§5h + `[[inputs.exec]]` 10 s). **À déployer sur les nœuds** pour l'état réel des pools ; en attendant, `zfs_pool_state` = pool inconnu (null → pas d'échantillon, pas de faux OK).
- **GET /api/alarms/targets** : section `sensors` ajoutée — `{ smart: SmartDevice[], sensors: SensorReading[], units: FailedUnit[], pools: ZfsStatus[] }` (types shared `node-sensors.ts` ; `null` si InfluxDB indisponible — le formulaire l'indique). Mêmes données que le moteur, via le même `fetchSensorAlarmData` (donc le formulaire de règle et l'engine voient la même réalité).
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
- **REST v1** : token d'API Centreon sur la **nouvelle API** `/api/latest/`, en-tête **`X-AUTH-TOKEN`** (pas Basic auth) : ressources `/configuration/hosts`, `/configuration/services`, `/configuration/pollers`, `/configuration/commands`. **Refait en issue #13** (`aa88af2`) : `provision.ts` cible `/api/latest/` + `X-AUTH-TOKEN`, auto-provisionnement complet (hôte auto-créé si `hostAddress` fourni et absent, commande `check_dummy` si absente, service passif idempotent, puis `generate` + `reload` du poller). Validé E2E sur Centreon 26.10 (GitHub #4 : 5 services créés + supprimés).

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

**Suppression du service (GitHub #20) — cohérence Prox4u ↔ Centreon** : la route `DELETE /api/alarms/rules/:id` retire le **service Centreon AVANT la règle** (`deleteCenteronService` dans `provision.ts`, selon le transport) :
- **Résultat** `DeleteServiceResult { status: 'deleted' | 'not-found' | 'error'; message }` :
  - **REST** : `GET /configuration/services?filter[name]=<svc>` (match exact — **seul** paramètre de filtre fonctionnel, cf. §7) → absent = `not-found` (idempotent, **pas** de generate/reload) ; présent → `DELETE /configuration/services/{id}` + `GET /configuration/monitoring-servers/{pollerId}/generate` + `/reload` = `deleted` ; toute exception (réseau/HTTP) = `error`.
  - **CLAPI** : `clapiDeleteCommands` (shared) = `SERVICE -a del` + `POLLERGENERATE` + `CFGMOVE` ; si la ligne `del` échoue avec un message « absent » (heuristic `CLAPI_NOT_FOUND_RE` : not found/exist/no such/unknown/introuvable/absent/inexistant) → `not-found` (idempotent), sinon `error`.
- **Cohérence** : `deleted`/`not-found` → `store.deleteRule` (réponse `{ ok:true, centreon }`) ; `error` (central injoignable) → la règle **reste**, marquée `pendingDeletion` (`store.markPendingDeletion` : + `pendingDeletionError` + `pendingDeletionAt`) → réponse `{ ok:false, pending:true, centreon:'pending', message }` (HTTP 200).
- **Réessai automatique** : `engine.ts` → `retryPendingDeletions(cfg)` appelé dans `tick()` **AVANT** `if (!cfg.enabled) return;` (marche module désactivé — c'est du nettoyage) ; **throttle 60 s/règle** (`PENDING_RETRY_MS`, tick 15 s) ; succès → `deleteRule` + log `SUPPRESSION FINALISÉE` ; échec → `pendingDeletionError`/`pendingDeletionAt` mis à jour + log warn. **Réessai manuel** = re-cliquer Supprimer (même route, non throttlé). Auto-réparateur : si le service a disparu entre-temps, le prochain essai renvoie `not-found` et la règle est retirée.
- **UI** : badge orange `bg-warn/15 text-warn` « Suppression en attente » dans la colonne Alarme (tooltip = dernière erreur) + flash dans `doDelete` (`alarm.delete.ok` / `.notFound` / `.pending`). i18n `alarm.confirm.delete` mis à jour (« Le service Centreon associé sera supprimé »).
- **Hôte Centreon** : non supprimé s'il est **partagé** (une autre règle le cible) ou **préexistant** (créé par l'admin) — seul le service part. S'il a été **auto-créé par Prox4u** et devient orphelin (aucune règle + 0 service) → supprimé (orphelin, cf. ci-dessous, GitHub #21).
- **Migration store #20** : `init()` complète `pendingDeletion false` / `pendingDeletionError null` / `pendingDeletionAt null` sur les règles existantes.

**Suppression de l'HÔTE (orphelin — GitHub #21) — cohérence Prox4u ↔ Centreon** : règle d'or — Prox4u ne supprime un hôte Centreon que s'il l'a **créé lui-même** et qu'il est **orphelin**. `orphan.ts` → `tryDeleteOrphanHost(store, cfg, poller, host, excludeRuleId?)` — **3 garde-fous cumulés** (tous obligatoires) :
1. **`managedHosts`** : l'hôte a été **auto-créé par Prox4u** (provisioning REST, `hostCreated:true` → `store.addManagedHost(host, pollerId)` à la création **et** au re-provisionnement). Un hôte créé à la main par l'admin n'y figure jamais → **jamais supprimé**.
2. **Aucune règle ne cible l'hôte** (hors la règle en cours de suppression, `excludeRuleId`) → sinon d'autres services Prox4u y vivent encore.
3. **0 service restant sur l'hôte** (`countHostServices`) → protège les sondes ajoutées à la main par l'admin sur un hôte créé par Prox4u. `null` (inconnu — CLAPI / central injoignable) → **conservé** (conservatif).

- **`deleteCenteronHost`** (`provision.ts`) → `DeleteHostResult { status: 'deleted' | 'not-found' | 'error' }` :
  - **REST** : `GET /configuration/hosts?filter[name]=<host>` (match exact) → absent = `not-found` (idempotent, **pas** de generate/reload) ; présent → `DELETE /configuration/hosts/{id}` + `generate` + `reload` du poller = `deleted` ; toute exception = `error`.
  - **CLAPI** : `clapiDeleteHostCommands` (shared) = `HOST -a del` + `POLLERGENERATE` + `CFGMOVE` ; message « absent » (`CLAPI_NOT_FOUND_RE`) → `not-found` (idempotent), sinon `error`.
- **`countHostServices`** (`provision.ts`) : l'API ne filtre **PAS** les services par hôte (`filter[host_id]` → 500 « paramètre non autorisé », cf. §7) → on liste les services (pagination, **limite 10/page imposée**, `meta.total`) et on compte **côté client** ceux dont le tableau **`hosts[]`** contient l'hôte (les services ont `host_id = null` dans la réponse). `stopAt` court-circuite (le garde-fou n'a besoin que de 0 vs >0). Hôte absent (REST) → 0 ; CLAPI / central down → `null`.
- **Flux combiné (route DELETE + engine retry)** : après service supprimé (`deleted`/`not-found`) → `tryDeleteOrphanHost` (avec `excludeRuleId` = la règle supprimée) :
  - hôte supprimé/absent → `removeManagedHost` + `deleteRule` → réponse `{ ok:true, centreon, hostDeleted:true }`.
  - échec hôte (`error`, central down) → la règle **reste** `pendingDeletion` (réessai idempotent : service déjà absent + hôte à supprimer) → `{ ok:false, pending:true }`.
  - hôte conservé (garde-fou) → `deleteRule` → `{ ok:true, hostDeleted:false }`.
- **Balayage périodique** (`engine.ts` → `sweepOrphanHosts`, appelé dans `tick()` **AVANT** `if (!cfg.enabled) return;` — tourne même module désactivé ; filet de sécurité qui rattrape les orphelins laissés par un échec de suppression) : toutes les `config.orphanSweepMinutes` minutes (défaut **30**, **0 = off**, settable via `PUT /api/alarms/config`, **pas exposé UI**) ; throttle en mémoire (`lastOrphanSweep` — court au 1ᵉʳ tick après startup) ; pour chaque hôte de `managedHosts` : une règle le cible → skip (sans API) ; sinon `tryDeleteOrphanHost` (sans `excludeRuleId`) → supprimé → `removeManagedHost` + log `ORPHAN HOST SUPPRIMÉ` ; `error` → warn (réessai au balayage suivant) ; central down → `countHostServices` null → conservé (pas de log de spam).
- **UI** : `DeleteOutcome.hostDeleted` → flash `alarm.delete.okHost` (« Règle supprimée — service et hôte Centreon supprimés (orphelin). ») ; `alarm.confirm.delete` mentionne l'hôte (« …sera supprimé (et l'hôte s'il devient orphelin). »).
- **Migration store #21** : `init()` complète `managedHosts []` si absent.

### 4.3 Engine — machine à états v2 (hystérésis / suppression / ack) + trames périodiques
Tick 15 s, pour chaque règle active (module actif) : échantillonner la métrique → `evaluateAlarmHysteresis` (moteur v2, GitHub #5) → transitions **ok⇄firing** → trame à chaque transition (alarme = code sévérité, récupération = 0). L'état bascule **avant** l'envoi (transition consommée même si `send_nsca` échoue → pas de boucle). Échec = `lastSendState=error` + message, **aucun crash**.

**Échantillonnage capteurs (GitHub #4)** : pour les 5 métriques capteurs, la valeur vient d'InfluxDB raw via `SensorDataCache` (TTL 60 s, 1 `fetchSensorAlarmData`/min partagé) et non du ring-buffer poller — **pas de retour anticipé si l'endpoint PVE est injoignable** (les capteurs sont indépendants de l'API PVE). Le seuil passe par `resolveSensorThresholds` (seuil effectif perso ≤ firmware pour `sensor_temp_c`, seuils perso lus à chaud via `ctx.sensorThresholds.getThresholds()`). `value = null` (cible inconnue) → **pas d'échantillon** → ni trigger ni recover (jamais de faux OK). Le check hôte (`PROCESS_HOST_CHECK_RESULT`) s'applique aussi aux cibles `kind='node'` des règles capteurs (nœud online→0 / offline→1).

**Moteur v2 (GitHub #5)** — les trames coulent **TOUJOURS** aux transitions réelles + heartbeat (Centreon reflète l'état réel OK/critique) ; l'anti-flapping est au niveau de la machine à états, pas en coupant les trames :
- **Hystérésis** : `AlarmRule.recoveryThreshold: number | null` (null = seuil de déclenchement, rétrocompatible). `evaluateAlarmHysteresis()` (shared) → `{ trigger, recover, value }` : `trigger` = fenêtre entière au-dessus du seuil de déclenchement ; `recover` = fenêtre entière repassée du côté **sûr** du seuil de récupération → **zone morte** anti-flapping (ex. op « > » seuil 90 / récup 80 : déclenche >90 soutenu, récupère ≤80 soutenu, entre 80 et 90 = aucun basculement). Validation serveur : pour « > » `rec < threshold`, pour « < » `rec > threshold` (sinon 400 `bad-recovery-threshold` / `fields`).
- **Suppression = durée minimale de firing** : `AlarmRule.suppressSeconds` (0 = off). Une fois en alarme, la règle ne récupère qu'après `now − lastAlarmAt ≥ suppressSeconds` (helper `minFiringElapsed`) — casse la boucle alarme→récup→alarme.
- **Ack = marqueur (ne coupe pas les trames) + auto-résolution** : `acknowledgedAt`/`acknowledgedBy` posés par `POST /api/alarms/rules/:id/ack` (username via `req.authUser` + `auth.store.userById`), retirés par `/unack`. **La récupération (firing→ok, trame code 0) réinitialise l'ack** (`sendAndRecord` + patch extra). `registerAlarmRoutes` reçoit `auth: AuthContext` (index.ts passe `ctx.auth`).
- **Migration store** : `init()` complète les champs v2 absents sur les règles existantes (défauts `recoveryThreshold null` / `suppressSeconds 0` / ack null) + persist si modifié.
- `tick()` rendu **public** (tests) ; tests engine avec `vi.useFakeTimers` + `vi.setSystemTime` + mock `./nsca.js`.

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
- **Moteur v2 : les trames coulent TOUJOURS** (GitHub #5) — ni l'ack ni la suppression ne coupent les trames NSCA : Centreon reflète l'état réel (OK ou critique) à chaque transition + heartbeat. L'anti-flapping est au niveau de la **machine à états** (hystérésis = zone morte + durée minimale de firing), pas en filtrant les trames. L'ack est un **marqueur** (UI : qui/quand) réinitialisé par l'auto-résolution (récupération).
- **Règles capteurs : source = InfluxDB raw, pas le snapshot poller** (GitHub #4) — les capteurs ne sont collectés que par l'agent Telegraf des nœuds ; lire la base `raw` rend les règles capteurs **indépendantes de l'API PVE** (fonctionnent même si l'endpoint est injoignable). 1 lecture/min partagée (`SensorDataCache` 60 s) pour toutes les règles capteurs.
- **Seuil effectif perso ≤ firmware pour `sensor_temp_c`** (GitHub #4) : la règle suit l'onglet admin « Seuils capteurs » (le seuil perso, déjà clampé ≤ firmware, **remplace** le seuil saisi dans la règle) ; repli sur le seuil de la règle si aucun seuil défini pour le capteur. Cohérence hystérésis : un `recoveryThreshold` du mauvais côté du seuil effectif est replié sur le seuil de déclenchement.
- **Inconnu ≠ dégradé** (GitHub #4) : `sensorMetricValue` renvoie `null` (pas `0`) quand la cible est inconnue (unité absente, pool absent, SMART healthOk null, temp SMART 0 °C) → pas d'échantillon → **jamais de faux OK ni de faux CRIT** (ex. disque virtuel sans SMART, ZFS non installé).
- **État des pools ZFS via script exec, pas le plugin zfs** (GitHub #4) : le plugin zfs de Telegraf ne collecte que l'ARC + counters I/O (pas de champ `state`) → `prox4u-telegraf-zpool.sh` (`zpool status -p -H -o name,state` → table `zpool`), même pattern que les scripts exec quorum/reboot/updates.

## 7. Pièges
- **Filtre services : seul `filter[name]` fonctionne (GitHub #20, découvert en E2E)** : sur `GET /configuration/services`, les paramètres **`name`**, **`host_id`**, **`service_description`**, **`search`** sont **silencieusement IGNORÉS** (la liste complète est renvoyée quelle que soit la valeur — même `?name=nonexistent` renvoie tout). **Seul `filter[name]=<nom>` (match EXACT) filtre côté serveur.** Conséquence : sans `filter[name]`, la liste peut être **tronquée** (page par défaut) et le service cible introuvable → faux « not-found » ou (pire) suppression du **mauvais** service si on prend `result[0]`. `provision.ts` utilise `filter[name]` (provision + delete) + un `.find((s) => s.name === service)` côté client en garantie. ⚠ En E2E, une commande shell manuelle qui prenait `result[0]` avec `?name=` (ignoré) a supprimé le mauvais service — toujours matcher par nom, jamais par position.
- **Compter les services d'un hôte : aucun filtre par hôte (GitHub #21, découvert en E2E)** : sur `GET /configuration/services`, **`filter[host_id]`**, **`filter[hosts]`**, **`filter[host]`** → **HTTP 500** « Le paramètre … n'est pas autorisé » (contrairement à `filter[name]` qui marche). Pas de sous-ressource `GET /configuration/hosts/{id}/services` (**404**). Les services portent un tableau **`hosts: [{id, name}]`** (le champ `host_id` est **null** dans la réponse, même s'il sert au POST de création). → `countHostServices` liste les services (pagination) et compte **côté client** ceux dont `hosts[]` contient l'hôte.
- **Pagination services : limite 10/page FIXE (GitHub #21)** : `page_size` est **ignoré** (toujours `meta.limit = 10`) ; **`meta.total`** donne le total → paginer `?page=N` jusqu'à `page × 10 ≥ meta.total` (garde anti-boucle 100 pages). Mêmes règles pour `GET /configuration/hosts` (`?name=` ignoré → **seul `filter[name]`** filtre, cf. piège services — le `findHostId` d'origine utilisait `?name=` + `.find()` client, corrigé en #21).
- **Hôte orphelin à la suppression de règle — RÉSOLU (GitHub #21)** : avant #21, seul le service partait → un hôte auto-créé par Prox4u (REST) restait orphelin (ex. `proxmox`, `ProxSite1` — nettoyés par le balayage au 1ᵉʳ démarrage post-migration). Maintenant : `managedHosts` tracke les hôtes auto-créés + suppression orpheline (3 garde-fous, cf. §4.2) + balayage périodique. ⚠ **Un hôte créé par l'admin Centreon (sans passer par Prox4u) n'est JAMAIS supprimé** (pas dans `managedHosts`) — même s'il n'a plus de service ni de règle Prox4u.
- **Service orphelin à la suppression de règle — RÉSOLU (GitHub #20)** : avant #20, `DELETE /api/alarms/rules/:id` ne faisait que `store.deleteRule` → le service Centreon restait orphelin (nettoyage manuel). Maintenant la route supprime le service Centreon **avant** la règle (cf. §4.2 « Suppression du service ») avec état « suppression en attente » + réessai automatique si le central est injoignable.
- **Transport REST = nouvelle API** : la nouvelle API Centreon est servie sur `/api/latest/` (pas `/api/restapi/`, qui renvoie le fallback SPA 404) et s'authentifie par l'en-tête **`X-AUTH-TOKEN`** (pas Basic auth user:token). Les ressources sont `/configuration/hosts`, `/configuration/services`, `/configuration/pollers`, `/configuration/commands` (pas `/host`, `/service`, `/instance/poller`). Le token est stocké dans `security_token` + `security_authentication_tokens` (schéma 21.10+), pas dans l'ancienne table `token`. `provision.ts` est aligné sur ce contrat (issue #13) — validé E2E.
- **Table `zpool` absente tant que Telegraf n'est pas redéployé** (GitHub #4) : les nœuds doivent être redéployés avec `deploiement/60-telegraf-nodes.sh` (script exec `prox4u-telegraf-zpool.sh`) pour que l'état réel des pools arrive dans la base `raw`. En attendant, `zfs_pool_state` = pool inconnu (null → pas d'échantillon, pas de faux OK) et `fetchSensorAlarmData` log un warn « pools ZFS indisponibles » (isolation par section — les autres métriques capteurs marchent).
- **`/api/admin/sensor-thresholds` est admin-only** (GitHub #4) : le seuil effectif de `sensor_temp_c` se règle dans l'onglet admin « Seuils capteurs » — un user (rôle `user`) reçoit 403 `admin-required`. Le moteur lit les seuils à chaud (pas de cache) : un changement de seuil s'applique au tick suivant (15 s).
- **Cible capteur = identifiant exact** (GitHub #4) : `device` = nom du disque tel que Telegraf l'expose (ex. `nvme0n1`, sans `/dev/`), `chip`/`feature` = puce + feature lm-sensors (ex. `amdgpu-pci-0300`/`junction`), `unit` = nom systemd exact (ex. `openipmi.service`), `pool` = nom du pool ZFS. Une faute de frappe = cible inconnue (null) → la règle ne déclenche jamais (pas d'erreur).
- **send_nsca absent** → le binaire doit être installé sur le serveur Prox4u (`apt install nsca-client` / `nsca`), sinon `send_nsca indisponible`. Le fichier `send_nsca.cfg` est généré automatiquement par l'app.
- **Service non déployé** → les trames sont rejetées par le daemon NSCA si le service n'a pas été `CFGMOVE`'d. Toujours enchaîner génération+déploiement.
- **`check_dummy!0`** est une commande factice (jamais exécutée, passive pur) — ne pas la remplacer par un vrai check.
- **Fenêtre de confirmation** : `evaluateAlarmHysteresis` (v2) ne déclenche (`trigger`) que si **tous** les échantillons de la fenêtre dépassent le seuil de déclenchement, et ne récupère (`recover`) que si **tous** repassent du côté sûr du seuil de récupération ; une fenêtre vide (pas de données) ne déclenche NI ne récupère (la valeur passe en null). `evaluateAlarm` (v1) reste exportée (rétrocompat) mais l'engine utilise la v2.
- **Échappement** : `escapeNscaField` échappe d'abord les `\` puis `;`/`\n` — ne pas réordonner (sinon double-échappement).

## 8. Tests
- `packages/shared/src/centreon-nsca.test.ts` (69) : `nscaReturnCode`, `escapeNscaField` (`;`/`\n`/tab), `buildNscaFrame` (trame service 4 champs), `buildNscaHostFrame` (trame hôte 3 champs, sans service), `renderOutput`, `defaultServiceName`, `suggestCenteronHost`, `conditionMet`, `evaluateAlarm` (fenêtre), `evaluateAlarmHysteresis` (v2 : trigger/recover, zone morte, rétrocompat null, op « < » symétrique, **anti-flapping** oscillation → 1 trigger/0 recover), `nscaCfgContent`, `clapiProvisionCommands` (séquence exacte), `clapiDeleteCommand`, **`clapiDeleteCommands` (GitHub #20 : séquence del + POLLERGENERATE + CFGMOVE, échappement `;`)**, **`clapiDeleteHostCommand`/`clapiDeleteHostCommands` (GitHub #21 : `HOST -a del` + POLLERGENERATE + CFGMOVE, échappement `;`)**, **`defaultCenteronConfig` (GitHub #21 : `orphanSweepMinutes` défaut 30)**, **capteurs (GitHub #4)** : `sensorMetricValue` (5 métriques, tri-state null = inconnu, SMART healthOk null ≠ FAILED, temp 0 °C = inconnu, pool ≠ ONLINE = 0), `resolveSensorThresholds` (seuil effectif perso ≤ firmware prime, repli seuil règle, cohérence hystérésis), `sensorTargetFields` / `isSensorMetric` / `SENSOR_METRICS`.
- `packages/server/src/modules/centreonnsca/store.test.ts` (21) : seed, persistance, CRUD règles (dont `lastOkSendAt`), setConfig (normalisation `okHeartbeatSeconds`/`hostCheckSeconds`/`orphanSweepMinutes`), setPollers (slug+dédup), upsertMapping, stats 24 h, **migration v2** (règle sans champs hystérésis/suppression/ack → défauts), **migration #20** (règle sans champs `pendingDeletion*` → défauts false/null/null) + **`markPendingDeletion`** / **`listPendingDeletions`** (état « suppression en attente »), **orphelins (GitHub #21)** : `managedHosts` seed `[]`, `addManagedHost` (idempotent, poller d'origine conservé, persistance), `removeManagedHost`, `isManagedHost`, **migration #21** (fichier sans `managedHosts` → `[]` ré-écrit), `orphanSweepMinutes` défaut 30 / persistance / 0=off.
- `packages/server/src/modules/centreonnsca/routes.test.ts` (36) : GET/POST/PATCH/DELETE règles, validation 400, nom en double 409, test, provision, PUT config (masquage mdp + « inchangé »), **v2** : create hystérésis/suppression, 400 `bad-recovery-threshold`, 400 `suppressSeconds` négatif, PATCH `recoveryThreshold null`, **`/ack`** (`acknowledgedBy` user session) + **`/unack`** + 404, **capteurs (GitHub #4)** : validation cible capteur (400 `bad-sensor-target` / `fields`, kind=node + identifiant), `GET /api/alarms/targets` section `sensors`, **suppression cohérente (GitHub #20)** : DELETE supprime le service Centreon PUIS la règle (`deleteCenteronService` mocké, args host/service vérifiés), DELETE `not-found` → règle retirée (idempotent), DELETE `error` → règle conservée en `pendingDeletion` (+ `listPendingDeletions`), DELETE 404 si règle absente (pas d'appel Centreon), **orphelins (GitHub #21)** : POST `hostCreated:true` → `addManagedHost` (poller de la règle), POST `hostCreated` absent → pas tracké, DELETE orphelin (managed + aucune règle + 0 service) → `hostDeleted:true` + `deleteCenteronHost` appelé + retiré du tracking, DELETE hôte encore ciblé (autre règle) → conservé, DELETE hôte avec service restant (sonde admin) → conservé, DELETE hôte orphelin mais `deleteCenteronHost` `error` → règle en `pendingDeletion`, DELETE hôte non géré (admin) → jamais supprimé.
- `packages/server/src/modules/centreonnsca/engine.test.ts` (27) : machine à états — **anti-flapping** (oscillation → 1 trame code 2, critère d'acceptation), récupération hystérésis (zone morte → rien, ≤ seuil récup → code 0), boucle sans hystérésis (3 trames), `suppressSeconds` (pas de récup avant la durée), **auto-résolution** (récup clear l'ack), VM absente → pas de transition, **capteurs (GitHub #4)** : cycle ALARM→RÉCUP sur valeur InfluxDB, **seuil effectif** (perso ≤ firmware prime sur le seuil de la règle), `value null` → pas de transition (pas de faux OK), endpoint injoignable → les règles capteurs s'évaluent quand même, **suppressions en attente (GitHub #20)** : `retryPendingDeletions` — Centreon « revient » (`deleted`) → règle retirée, `not-found` → règle retirée (idempotent), **throttle** (dernière tentative < 60 s → pas de réessai), Centreon toujours down (`error`) → règle conservée + `pendingDeletionError`/`pendingDeletionAt` mis à jour, pas de règle en attente → aucun appel, **réessai combiné (GitHub #21)** : service supprimé + hôte orphelin → hôte supprimé + règle retirée, hôte orphelin mais `deleteCenteronHost` `error` → règle reste en attente (hôte toujours tracké), **balayage orphelin (GitHub #21)** : `sweepOrphanHosts` — orphelin (managed + aucune règle + 0 service) → supprimé + retiré du tracking, hôte encore ciblé → conservé (sans API), service restant → conservé, **module désactivé → le balayage tourne quand même**, `orphanSweepMinutes=0` → désactivé, **throttle** (1 balayage par intervalle, pas à chaque tick), central down (`countHostServices` null) → conservé sans erreur. `vi.useFakeTimers` + `vi.setSystemTime` + mock `./nsca.js` + mock `./provision.js` (⚠ `vi.clearAllMocks()` ne réinitialise PAS les implémentations `mockResolvedValue` → état de base reposé dans `beforeEach`).
- `packages/server/src/modules/centreonnsca/provision.test.ts` (35) : séquence CLAPI + REST v1 (mock fetch « monde » Centreon **fidèle** — ignore `name`/`host_id`, honore `filter[name]`, **services avec `hosts[]` + pagination `?page=N` + `meta.total`** (limite 10/page), enregistre la query), **suppression (GitHub #20)** REST : service présent → DELETE + generate/reload (`deleted`), service absent → `not-found` (pas de generate/reload), **plusieurs services → supprime le BON** (régression E2E : assert `query === '?filter[name]=…'`, le service réel reste), erreur réseau → `error` (jamais d'exception), token manquant → `error` avant HTTP ; **suppression CLAPI** : séquence complète (del + POLLERGENERATE + CFGMOVE → `deleted`), `SERVICE -a del` « not found » → `not-found` (idempotent, s'arrête), échec non « not found » → `error`, hôte non configuré → `error` avant spawn (mock `node:child_process`) ; **orphelins (GitHub #21)** : `provisionService` `hostCreated` (hôte absent → `true`, présent → `false`, CLAPI → `false`), `deleteCenteronHost` REST (présent → DELETE + generate/reload `deleted`, absent → `not-found` sans generate, **plusieurs hôtes → supprime le BON** `filter[name]`, erreur réseau → `error`, token manquant → `error` avant HTTP), CLAPI (séquence `HOST -a del` + POLLERGENERATE + CFGMOVE → `deleted`, « not found » → `not-found`, échec → `error`), `countHostServices` (hôte avec 2 services → 2, services sur autre hôte → 0, hôte absent → 0, central down → `null`, CLAPI → `null`).
- `packages/server/src/modules/nodesensors/data.test.ts` (5, **nouveau GitHub #4**) : `fetchSensorAlarmData` — 6 requêtes, **isolation par section** (une section en erreur ne casse pas les autres), dernier point par cible (dédup), mapping des colonnes.

## 9. Exemples de trame & commande (livrable)
- Trame générée : `vm-web-01\tProx4u-Alarm-CPU\t2\tvm-web-01 CPU 94% (seuil 90%)\n`
- Commande CLAPI de création : `centreon -u clapi -p "$(cat)" -o SERVICE -a add -v "vm-web-01;Prox4u-Alarm-CPU"` (suivi des `setparam` + `POLLERGENERATE`/`CFGMOVE`).
- Script de test manuel : `scripts/nsca-test.sh` (envoie une trame vers un NSCA de test + vérifie le statut dans Centreon).

## 10. Validation E2E sur central réel (GitHub #1, clôturé 2026-11-27)
- **Central** : 192.168.1.130 (Centreon 26.10, poller 1, NSCA 5668 encrypt). Périmètre ~80 % validé
  par les E2E de #4 (règles capteurs) + #5 (moteur v2) ; delta de #1 = **passe UI Playwright** +
  **check sécurité** + doc/clôture. **Pas de CLAPI** (décision user) — le transport REST est le
  transport validé ; CLAPI reste « testé en code seulement » (séquence `clapiProvisionCommands`).
- **Passe UI Playwright (13/13 checks)** — session test-admin, Chromium headless : login →
  `/admin` onglet « Centreon (NSCA) » (config affichée, secrets masqués — 2 hints « Fourni via
  .env ») → `/alarms` (tableau 4 règles) → `/alarms/new` (création règle temporaire « UI E2E test »
  cible capteur `smart_temp_c` nvme0n1 > 100 WARNING → **provisioning OK** récap « Service créé et
  configuré ») → actions tableau : **Tester** (return code 0 — trame **vérifiée dans Centreon** :
  hôte proxmox, state OK, output « Prox4u — trame de test (check passif NSCA) »), **Reprovisionner**
  (réussi), **Désactiver** (active=false via API), **Activer** (active=true), **Supprimer** (règle
  retirée, dialogue confirm).
- **Check sécurité** : mdp NSCA + token REST = **0 occurrence** dans `logs/server.log` ;
  `GET /api/alarms` (admin) : `clapiPassword` / `restToken` / `nsca.password` = `••••••`,
  `envSecrets` = booléens (pas de valeurs), aucune valeur de secret dans la réponse brute.
- **Nettoyage** : règle supprimée (UI) + service Centreon orphelin supprimé (REST DELETE +
  `GET /configuration/monitoring-servers/1/generate` + `/reload`) — les 4 règles/services réels
  intacts.
- **Écart préexistant (non traité en #1) → RÉSOLU en GitHub #20** : la route DELETE ne retirait pas le service
  Centreon (seul `store.deleteRule` — cf. #5) → le service orphelin était supprimé manuellement via
  REST (DELETE `/configuration/services/{id}` + generate/reload poller). #20 automatise cette suppression
  avec cohérence Prox4u ↔ Centreon + état « suppression en attente » (cf. §4.2).

## 11. Validation E2E suppression cohérente (GitHub #20, clôturé 2026-11-28)
- **Central** : 192.168.1.130 (Centreon 26.10, poller 1). 3 cas validés sur le vrai central :
  - **Cas nominal** : règle « E2E #20 delete » (service `Prox4u-Alarm-E2E20`) créée + provisionnée →
    `DELETE /api/alarms/rules/:id` → `{ ok:true, centreon:'deleted' }` → règle retirée de Prox4u,
    service disparu de Centreon (API config), les 4 services réels intacts.
  - **Cas idempotent** : service `Prox4u-Alarm-E2E20b` supprimé manuellement (REST DELETE + generate/reload)
    → `DELETE` règle → `{ ok:true, centreon:'not-found' }` → règle retirée (pas de generate/reload inutile).
  - **Cas pending (réessai automatique)** : règle `Prox4u-Alarm-E2E20c` créée → `PUT /api/alarms/config`
    `restUrl` → port mort (`:9999`) → `DELETE` → `{ ok:false, pending:true, centreon:'pending', message:'fetch failed' }`
    → règle **conservée** (`pendingDeletion:true`) → `PUT` config (restUrl restaurée) → **~80 s plus tard**
    l'engine réessaie (throttle 60 s) → `SUPPRESSION FINALISÉE` (log) → règle + service auto-supprimés.
- **Passe UI Playwright (5/5 checks)** — session test-admin : login → `/alarms` → clic Supprimer sur une
  règle (Centreon en port mort) → confirm → **flash** « Suppression en attente — Centreon injoignable
  (fetch failed), réessai automatique. » + **badge orange** « Suppression en attente » dans la colonne
  Alarme (tooltip = dernière erreur). ⚠ Le **build web** (`pnpm --filter @prox4u/web build`) doit être
  relancé après un changement UI — le serveur sert `packages/web/dist` (build statique, pas de HMR).
- **Découverte API (piège §7)** : `?name=`/`?host_id=`/`?service_description=`/`?search=` **ignorés**
  par `GET /configuration/services` — seul `?filter[name]=` (match exact) filtre. `provision.ts`
  corrigé (provision + delete) + test de régression (plusieurs services → supprime le bon).
- **Nettoyage** : 0 service `E2E20*` restant, 4 règles/services réels intacts, config restaurée
  (`restUrl` = `http://192.168.1.130/centreon`, `enabled:true`, 4 règles actives, 0 pending).

## 12. Validation E2E orphelins d'hôtes (GitHub #21, clôturé 2026-11-28)
- **Central** : 192.168.1.130 (Centreon 26.10, poller 1). Script `/tmp/opencode/e2e-orphan.mjs`
  (Node 24, fetch global, cookie jar test-admin, Centreon REST direct pour créer/supprimer
  hôtes+sondes admin) — **25/25 checks** sur le vrai central :
  - **(a) dernière règle → hôte supprimé** : règle créée (hôte `e2e-orphan-a` auto-créé,
    `hostCreated:true`) → `DELETE` → `{ ok:true, hostDeleted:true }` → hôte absent de Centreon.
  - **(b) hôte partagé** : 2 règles sur `e2e-orphan-b` → 1ʳᵉ `DELETE` → `hostDeleted:false`
    (hôte conservé, toujours présent) → 2ᵉ `DELETE` → `hostDeleted:true` (hôte absent).
  - **(c) hôte préexistant (admin)** : hôte `e2e-admin-c` créé **à la main** (REST POST) → règle
    créée (`hostCreated:false`, pas tracké) → `DELETE` → `hostDeleted:false` → **hôte admin conservé**.
  - **(d) central down → pending → réessai** : règle + hôte `e2e-orphan-d` créés → `restUrl` → port
    mort (`:9`) → `DELETE` → `{ ok:false, pending:true }` → `restUrl` restaurée → **~70 s** (throttle
    60 s) → réessai engine → règle retirée + **hôte supprimé** (log `SUPPRESSION FINALISÉE … + hôte supprimé`).
  - **(e) balayage** : règle + hôte `e2e-sweep-e` créés (tracké) → sonde admin ajoutée (service
    `Admin-Probe-E2E`) → `DELETE` → `hostDeleted:false` (sonde admin = 1 service → conservé) → sonde
    admin supprimée (hôte orphelin : tracké + 0 règle + 0 service) → `orphanSweepMinutes=1` →
    **~45 s** → **hôte supprimé par le balayage** (log `ORPHAN HOST SUPPRIMÉ`) → `orphanSweepMinutes`
    restauré à 30.
- **Migration one-shot** : les orphelins existants (`proxmox`, `ProxSite1` — 0 service, aucune règle)
  ajoutés à `managedHosts` (poller `poller`) → au 1ᵉʳ tick post-restart, le balayage les a supprimés
  (2 logs `ORPHAN HOST SUPPRIMÉ`) → `managedHosts` revenu à `[]`.
- **Passe UI Playwright (6/6 checks)** — session test-admin : règle créée via API (hôte auto-créé)
  → `/alarms` → clic Supprimer → **confirm** mentionne l'orphelin → **flash** « Règle supprimée —
  service et hôte Centreon supprimés (orphelin). » → règle retirée du tableau → hôte absent de Centreon.
- **Découvertes API (pièges §7)** : `filter[host_id]`/`filter[hosts]`/`filter[host]` → **500**
  « paramètre non autorisé » ; services portent `hosts[]` (`host_id` = null) ; `meta.total` + limite
  10/page fixe (`page_size` ignoré) ; pas de sous-ressource `/hosts/{id}/services` (404) ; `?name=`
  ignoré aussi pour les hosts (seul `filter[name]` filtre) → `findHostId` corrigé.
- **Nettoyage** : 0 hôte `e2e-*` restant, `ia-u24-01` + ses 3 services intacts, `managedHosts=[]`,
  config restaurée (`restUrl` + `orphanSweepMinutes=30`), 3 règles réelles actives.
