---
name: centreon-nsca
description: Plugin « Alarmes & Centreon » (famille centreon-nsca) — règles de surveillance sur VMs/nœuds/clusters Proxmox (dont quorum cluster via métrique cluster_quorum + Qdevice via cluster_qdevice + cible kind=cluster), engine d'évaluation (tick 15 s), provisioning du service passif Centreon via CLAPI (SSH/local) ou API REST v1, envoi des trames send_nsca, mapping VM→hôte Centreon (ajout manuel), pollers avec IP (destination NSCA), et page de config admin. Use when working on the centreon-nsca plugin, /api/alarms/*, the alarm engine, NSCA frames, Centreon provisioning, the /alarms pages, the cluster quorum/qdevice alarm, or the « Centreon (NSCA) » admin tab.
---

# Centreon NSCA — Alarmes & Centreon

Module qui transforme des **règles de surveillance** sur les VMs/nœuds/clusters Proxmox en **alarmes** transmises à **Centreon** sous forme de **checks passifs NSCA** (`send_nsca`). Cible : managers/DSI qui définissent des seuils, et le NOC Centreon qui reçoit les statuts.

> Un futur backend **Zabbix** partagera le namespace `/api/alarms/*` et le store sans toucher à cette famille. Le transport runtime NSCA est imposé ; le provisioning (création du service Centreon) peut passer par **CLAPI** ou **REST v1** (choix sur la page de config).

## 1. Périmètre & routes

| Surface | Où | Rôle |
|---|---|---|
| `/alarms` | `pages/rules.tsx` | **Page 2** — tableau des règles : filtres (texte/poller/état/provisionnement), recherche globale, tri, indicateurs, actions (activer/désactiver, modifier, supprimer, **Tester**, **Reprovisionner**) |
| `/alarms/new` | `pages/create-rule.tsx` | **Page 1** — formulaire de création → provisionne le service Centreon puis enregistre la règle + récap provisioning |
| `/alarms/edit/:id` | `pages/edit-rule.tsx` | Édition (même formulaire, ne re-provisionne pas) |
| Admin → onglet « Centreon (NSCA) » | `components/admin/nsca-config.tsx` | **Page 3** — activation du module, transport CLAPI/REST, central, pollers (nom + IP), NSCA, mapping VM→hôte (+ bouton Ajouter) |
| API | `GET/POST /api/alarms/*` | règles, cibles (VMs/nœuds/clusters), config, test, provisioning |
| Engine | `engine.ts` | tick 15 s, évaluation des règles actives, envoi des trames aux transitions |

Feature flag : `VITE_USE_PLUGIN_CENTREON_NSCA` (défaut ON, opt-out). Famille `centreon-nsca` (pas de versionnement `_vN` — premier module de la famille).

## 2. Arborescence du code

```
packages/shared/src/centreon-nsca.ts         # types + fonctions pures (testées)
packages/shared/src/centreon-nsca.test.ts    # 28 tests (échappement, trame, évaluation…)
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
- Trame construite par `buildNscaFrame` (shared) : les champs hôte/service sont **échappés** (`;`→`\;`, `\n`→`\n` littéral, tab→espace) contre l'injection.
- `output` = template `{{vm}} {{metric}} {{value}} {{threshold}}` rendu par `renderOutput`.
- Return code : 0=OK (récupération), 1=WARNING, 2=CRITICAL, 3=UNKNOWN (`nscaReturnCode`).

### 4.2 Provisioning — CLAPI **ou** REST v1 (choix Page 3)
Paramètres du service passif (les deux transports) : `passive_checks_enabled=1`, `active_checks_enabled=0`, `is_volatile=1`, `max_check_attempts=1`, `check_command=check_dummy!0` (factice, jamais exécutée).
- **CLAPI** : `centreon -u <u> -p <pass> -o SERVICE -a add -v "<host>;<svc>"` + `setparam` ×5, puis `POLLERGENERATE -v "<poller>"` + `CFGMOVE -v "<poller>"`. Séquence testée dans shared (`clapiProvisionCommands`). **Mode SSH** (Prox4u hors central — nominal) : `ssh <u>@<host> "centreon …"` ; **mode local** si Prox4u est sur le central. Le mot de passe est injecté **sur stdin** (`-p "$(cat)"`) → jamais dans l'argv (ps) ni loggué.
- **REST v1** : Basic auth (user + token d'API) sur `/api/restapi` : `GET /host`, `GET /command?search=check_dummy`, `POST /service`, `PUT /service/{id}` (params), `GET /instance/poller`, `POST /instance/poller/{id}/config/generate` + `…/config/move`.

**Enchaînement imposé** : création du service → génération de config → déploiement (`POLLERGENERATE`/`CFGMOVE` ou `config/generate`+`config/move`). Un service passif ne reçoit des trames NSCA qu'après déploiement.

### 4.3 Engine — machine à états
Tick 15 s, pour chaque règle active (module actif) : échantillonner la métrique → `evaluateAlarm` (la condition doit tenir sur **toute** la fenêtre de confirmation) → transitions **ok⇄firing** → trame à chaque transition (alarme = code sévérité, récupération = 0). L'état bascule **avant** l'envoi (transition consommée même si `send_nsca` échoue → pas de boucle). Échec = `lastSendState=error` + message, **aucun crash**.

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
- **send_nsca absent** → le binaire doit être installé sur le serveur Prox4u (`apt install nsca-client` / `nsca`), sinon `send_nsca indisponible`. Le fichier `send_nsca.cfg` est généré automatiquement par l'app.
- **Service non déployé** → les trames sont rejetées par le daemon NSCA si le service n'a pas été `CFGMOVE`'d. Toujours enchaîner génération+déploiement.
- **`check_dummy!0`** est une commande factice (jamais exécutée, passive pur) — ne pas la remplacer par un vrai check.
- **Fenêtre de confirmation** : `evaluateAlarm` ne déclenche que si **tous** les échantillons de la fenêtre dépassent le seuil ; une fenêtre vide (pas de données) ne déclenche pas (la valeur passe en null).
- **Échappement** : `escapeNscaField` échappe d'abord les `\` puis `;`/`\n` — ne pas réordonner (sinon double-échappement).

## 8. Tests
- `packages/shared/src/centreon-nsca.test.ts` (23) : `nscaReturnCode`, `escapeNscaField` (`;`/`\n`/tab), `buildNscaFrame`, `renderOutput`, `defaultServiceName`, `suggestCenteronHost`, `conditionMet`, `evaluateAlarm` (fenêtre), `nscaCfgContent`, `clapiProvisionCommands` (séquence exacte), `clapiDeleteCommand`.
- `packages/server/src/modules/centreonnsca/store.test.ts` (9) : seed, persistance, CRUD règles, setPollers (slug+dédup), upsertMapping, stats 24 h.
- `packages/server/src/modules/centreonnsca/routes.test.ts` (10) : GET/POST/PATCH/DELETE règles, validation 400, nom en double 409, test, provision, PUT config (masquage mdp + « inchangé »).

## 9. Exemples de trame & commande (livrable)
- Trame générée : `vm-web-01\tProx4u-Alarm-CPU\t2\tvm-web-01 CPU 94% (seuil 90%)\n`
- Commande CLAPI de création : `centreon -u clapi -p "$(cat)" -o SERVICE -a add -v "vm-web-01;Prox4u-Alarm-CPU"` (suivi des `setparam` + `POLLERGENERATE`/`CFGMOVE`).
- Script de test manuel : `scripts/nsca-test.sh` (envoie une trame vers un NSCA de test + vérifie le statut dans Centreon).
