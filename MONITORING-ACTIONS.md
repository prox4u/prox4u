# Monitoring — Points à effectuer (TODO priorisée)

Liste d'actions pour améliorer le **monitoring et les graphiques** de prox4u, en s'inspirant de
**ProxMenux** (référence, lecture seule). Détail de l'analyse dans le skill
[`skills/monitoring-proxmenux/SKILL.md`](skills/monitoring-proxmenux/SKILL.md).

Priorité : **valeur / effort**. P0 = à faire en premier. Statut : `[ ]` à faire · `[~]` en cours · `[x]` fait.

---

## P0 — Telegraf sur les nœuds Proxmox  `[~]`

Capturer les métriques locales que l'API PVE ne donne pas : **SMART** (détection prédictive des
pannes disque), **températures** (CPU/disques), **ZFS** (ARC, santé pools), **unités systemd**,
**disk/diskio/mem/cpu/system**. C'est le plus gros gisement d'amélioration.

- `[x]` **Prérequis réseau** : exposition de l'API InfluxDB aux nœuds — variable `INFLUX_LAN_BIND`
      (binding `${INFLUX_LAN_BIND:-127.0.0.1}:8181:8181` dans `docker-compose.yml`,
      `INFLUX_LAN_BIND=192.168.1.180` dans `.env`). **Validé live** : write+read via l'IP LAN OK.
- `[x]` Script **`deploiement/60-telegraf-nodes.sh`** (bare-metal, `--dry-run`, idempotent).
      Prend `TELEGRAF_INFLUX_TOKEN` (requis), `INFLUX_URL`, `INFLUX_BUCKET`, `PING_TARGET`.
      Contenu :
  - Clé GPG InfluxData (si le dépôt est déclaré) + `apt-get install telegraf smartmontools lm-sensors`
  - Auto-détection des devices SMART via `smartctl --scan` (SATA, SAS, NVMe, RAID, LUN, baies)
  - Générer `/etc/telegraf/telegraf.conf` : `[[outputs.influxdb_v2]]` avec
    `insecure_skip_verify=true`, `timeout=10s`, `global_tags node=<hostname>`
  - Plugins : `smart`, `sensors`, `zfs`, `systemd_units`, `disk`/`diskio`/`mem`/`cpu`/`system`
    (ping ICMP commenté — à réactiver si CAP_NET_RAW disponible)
  - Override systemd `User=root` (accès aux devices raw pour smartctl)
  - `systemctl enable --now telegraf` + self-test
- `[x]` **Nœud pilote (192.168.1.80, hostname « proxmox »)** : **validé** — 9 tables actives dans
  `raw` : `smart_device`, `sensors`, `zfs`, `systemd_units`, `disk`, `diskio`, `mem`, `cpu`, `system`.
  3 disques détectés (sda TOSHIBA, nvme0n1 + nvme1n1 CT4000P310SSD8).
- `[x]` **Nœud cluster ProxSite1** : **validé** — 2 disques détectés (sda, sdb), self-test OK.
- `[x]` **Nœud cluster ProxSite2** : **validé** — 8/9 tables actives (sensors vide, pas de capteur).
- `[x]` **Module web `node-sensors` v1** (Option A — nouvelle famille de plugin, aucun module
  existant touché) : `packages/web/src/plugins/node-sensors/` + flag `USE_PLUGIN_NODE_SENSORS`
  dans `core/config/features.ts` + enregistrement dans `core/plugin/plugins.ts` + i18n
  `nav.nodeSensors` + `DEFAULT_MODULES` (auth) + routeur serveur `/api/node-sensors` (cache 1 min,
  try/catch par section) + page 4 tableaux (SMART, capteurs, ZFS ARC, unités systemd) + filtre
  multi-choix des sections.
- `[x]` **Consolidation Telegraf 15 min** : le consolidateur agrège `smart_device`, `sensors`,
  `zfs`, `systemd_units` de `raw` vers `consolidated` (buckets 15 min) — historique infini.
- `[x]` **Seuils capteurs personnalisés** (livré) : seuil perso **≤ firmware** (clamp input +
   serveur), jamais au-dessus. Persistance `data/sensor-thresholds.json`, onglet Administration
   « Seuils capteurs » (guard admin, `GET/PUT/DELETE /api/admin/sensor-thresholds`), le tableau
   capteurs suit le seuil effectif (`tempTone`/`effectiveSensorThreshold`, shared).
   → Plan : [`docs/plan-seuils-capteurs.md`](docs/plan-seuils-capteurs.md)
- `[ ]` **Règles d'alarme** (SMART critique, température > seuil, unité échouée) dans le module
  `centreonnsca` (dépend des seuils perso ci-dessus).

> Token : par défaut le token admin de `.env`, surchargeable via `TELEGRAF_INFLUX_TOKEN`
> (token dédié possible). Telegraf tourne en bare-metal sur le nœud (pas virtualisé), en root
> (override systemd) pour l'accès aux devices raw.
>
> NB : la table Telegraf pour SMART s'appelle `smart_device` (pas `smart`).

---

## P1 — Alarme quorum cluster  `[x]` (livré + validé E2E)

Donnée **déjà pollée** (`/cluster/status` expose le quorum) → coût ~0, valeur **critique**
(un nœud qui perd le quorum laisse tourner ses guests mais bloque toute opération).
Modèle : check `system.cluster_quorum` de ProxMenux (CRITICAL).

- `[x]` Exposer le champ quorum dans le snapshot (poller) + règle d'alarme « quorum perdu »
  (métrique `cluster_quorum` + cible `kind: 'cluster'` — voir skill `centreon-nsca`).
- `[x]` Reflet dans le Health Score (pénalité −25) et la vue d'ensemble (badge + alerte crit).
- `[x]` **Failover d'endpoint** : l'URL de l'endpoint injoignable (nœud down) → le client
  bascule sur l'API d'un autre nœud du cluster (timeout connect 5 s, retour auto à la primaire
  quand elle récupère) + champ `apiVia` dans le snapshot + badge « API via … » (voir skill `api`).
- `[x]` **Validation E2E** (lab nested, cluster 2 nœuds + **Qdevice** sur la VM NFS) :
  - Perte : nœud endpoint arrêté + Qdevice (NFS) déconnecté → `quorate=0` → `quorumState=lost`,
    health 30 critical (nodeDown −25 + quorumLost −25 + praCrit −20), alerte crit, **badge rouge
    « Quorum perdu »** + badge failover « API via 192.168.1.201:8006 » (screenshot
    `docs/screenshots/quorum-lost-failover.png`).
  - Récupération : nœud relancé + NFS reconnectée → `quorate=1` → `state=ok`, badge vert
    « Quorum 2/2 », `apiVia` disparu (retour sur l'endpoint configuré).
  - **Note Qdevice** : le cluster a 3 votes (2 nœuds + Qdevice, quorum=2). 1 nœud down seul
    **ne perd pas** le quorum (le Qdevice le maintient) ; il faut nœud down **+** Qdevice down.
    L'app lit `quorate` (la vérité, Qdevice inclus) → comportement correct. → GitHub issue #3 (clôturée).
- `[x]` **Surveillance du Qdevice** (état réel, pas seulement déduit) : l'API PVE n'expose
  **que** `quorate` + `nodes` (vérifié dans le code source PVE) — l'état du Qdevice (en ligne /
  hors ligne) et le détail des votes n'existent qu'au niveau **corosync**. Solution :
  - Script Telegraf `exec` `prox4u-telegraf-quorum.sh` (déployé par `deploiement/60-telegraf-nodes.sh`)
    parse `pvecm status` → table `quorum_detail` (expected_votes, total_votes, quorum_threshold,
    quorate, has_qdevice, qdevice_online) dans la base `raw`.
  - Poller lit le dernier point (cache 30 s, fenêtre 10 min) → état **réel** du Qdevice
    (`up`/`down`/`absent`) dans le snapshot + repli sur la déduction API (`deriveQdeviceState`)
    si agent non déployé.
  - **Badge** page cluster (🟢 « Qdevice en ligne » / 🔴 « Qdevice hors ligne ») + **alerte warn**
    `qdevice-down` (le quorum n'est plus protégé si un nœud tombe).
  - `QuorumDetail` (votes) exposé dans le snapshot (`cluster.quorumDetail`).
  - **Pénalité Health Score −10** si `qdevice === 'down'` (`health.penalty.qdeviceDown`, même
    poids que praWarn — risque, pas incident ; cumulable avec quorumLost −25).
  - **Métrique Centreon NSCA `cluster_qdevice`** (cible `kind: 'cluster'`) : up/absent=1,
    down=0, unknown=null ; service `Prox4u-Alarm-CLUSTER-QDEVICE` (cf. skill centreon-nsca).
  - **Déployé** sur les nœuds ProxSite1/ProxSite2 (2026-11-20, via QGA exec du parent PVE —
    le script est idempotent, re-run `60-telegraf-nodes.sh` sur un nœud pour le refaire).
  - Validé E2E **avec données réelles** : `systemctl stop corosync-qnetd` (VM Qdevice) →
    `qdevice=down` + alerte warn + **Health Score −10** (quorum maintenu par les 2 nœuds) ;
    `start` → `qdevice=up`, alerte disparue, score restauré. Screenshot `docs/screenshots/qdevice-online-badge.png`.

---

## P2 — Moteur d'alarmes v2 (hystérésis / suppression / ack)  `[ ]`

Renforcer le moteur `centreonnsca` (ok⇄firing, tick 15 s) avec la mécanique ProxMenux :

- `[ ]` **Hystérésis de sortie** : seuil de **récupération** distinct (et plus bas) que le seuil
  de déclenchement → anti-flapping (ex. déclenche à >90 %, récupère à <80 %).
- `[ ]` **Suppression par règle** : fenêtre configurable pour ne pas ré-alermer en boucle.
- `[ ]` **Acknowledgment** manuel + **auto-résolution** (la condition disparaît → l'alarme se ferme).
- `[ ]` **Seuils du Health Score externalisés** : aujourd'hui `THRESHOLDS` est codé en dur dans
  `packages/shared/src/types.ts` → le porter dans un fichier de config hot-reload (pattern
  `overcommit.json`).

---

## P3 — Module « Audit / best-practices »  `[~]`

Un **2ᵉ score** (configuration) en complément du health score (ressources). La plupart des 43
checks ProxMenux sont **faisables via l'API PVE** avec les données déjà collectées.

**Architecture livrée (Phase 1)** : moteur d'audit pur `shared/audit.ts` (checks + score
déterministe `100 − Σ pénalités` : crit −10 / warn −5 / info −1, borné [0,100] ; libellés
≥80 Conforme · 50–79 À améliorer · <50 À revoir), calculé par le **poller** à chaque tick et
posé dans le snapshot WS (`snapshot.audit`) — la page `/audit` et les badges le lisent en direct,
zéro API. Module serveur `GET /api/audit` (sert le snapshot). Plugin web `audit` v1 (page
`/audit` + menu + flag `USE_PLUGIN_AUDIT` + module d'auth `audit`). Config VM étendue
(`unprivileged` LXC + `cpu=host` QEMU, cache 1 h). Score affiché vue d'ensemble (colonne
« Audit » du tableau endpoints) + détail endpoint (widget jauge). Constats **cliquables** vers
la VM (`/vms?tree=…&vm=…`) / nœud (`/e/:ep/n/:node`) / stockage (`/storage`) / cluster.

- `[x]` **Phase 1 — checks API (données déjà pollées)** : `qemu_without_agent` (crit),
  `privileged_containers` (warn), `cpu_host_type` (info), `bridge_without_ports` (warn),
  `thin_pool_overprovisioning` (warn/crit), `memory_overcommit` (warn/crit) + bonus
  `node_version_mismatch` (info).
- `[x]` **Page « Audit »** : score de configuration + liste des constats par sévérité,
  chaque constat cliquable vers la cible concernée.
- `[ ]` **Phase 2 — checks API supplémentaires** : `autostart`, `stuck_snapshots`,
  `replication_state`, `bond_members`, `zfs_arc_max`.
- `[ ]` **Phase 3 — checks agent (via Telegraf)** : `disk_errors`, `disk_service_life`,
  `failed_units`, `pending_reboot`, `security_updates`.

---

## P4 — Backups PBS + feed d'événements  `[~]` (déjà en roadmap STATUS.md)

Modéliser sur les checks ProxMenux (`backup.guest_coverage`, `last_backup_age`, `job_results`,
`verification_state`, `retention_defined`, `host_recovery`) :

- `[ ]` Backups PBS : KPI couverture (< 7 j), tableau par VM, capacité datastores PBS
  (nécessite token API PBS dans `.env` ; prévoir un **mode mock PBS** pour développer).
- `[ ]` Feed d'événements : tâches + changements détectés (le poller calcule déjà les deltas).
- `[ ]` Sondes actives 30 s par nœud + quorum/uptime (partiellement couvert par P1).

---

## P5 — Certificats + drift NTP  `[ ]`

Effort faible, valeur réelle :

- `[ ]` **Certificats** : expiration TLS de chaque endpoint Proxmox API (+ PBS) — lue depuis le
  client (modèle `security.certificate_expiry`).
- `[ ]` **Drift NTP** : écart horloge nœud vs serveur (header `Date` des réponses API) —
  modèle `system.time_synchronisation`.

---

## Transversal — sécurité (leçons ProxMenux, voir skill §3)

- `[ ]` Conserver **auth obligatoire + TLS par défaut** (ne pas reproduire le défaut ProxMenux :
  auth-off + bind toutes interfaces + HTTP).
- `[ ]` **Scopes lecture vs opération** dès la Phase 3 (start/stop/reboot).
- `[ ]` **IA : Ollama local par défaut**, cloud en opt-in explicite (ne pas envoyer SMART/hôtes
  par défaut).
- `[ ]` **Rate-limiting + 2FA** sur le login (à ajouter si absent).
- `[ ]` Vérifier les **permissions `600`** des fichiers de secrets (`data/auth.json`).
