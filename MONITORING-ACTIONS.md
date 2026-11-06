# Monitoring — Points à effectuer (TODO priorisée)

Liste d'actions pour améliorer le **monitoring et les graphiques** de prox4u, en s'inspirant de
**ProxMenux** (référence, lecture seule). Détail de l'analyse dans le skill
[`skills/monitoring-proxmenux/SKILL.md`](skills/monitoring-proxmenux/SKILL.md).

Priorité : **valeur / effort**. P0 = à faire en premier. Statut : `[ ]` à faire · `[~]` en cours · `[x]` fait.

---

## P0 — Telegraf sur les nœuds Proxmox  `[ ]`

Capturer les métriques locales que l'API PVE ne donne pas : **SMART** (détection prédictive des
pannes disque), **températures** (CPU/disques), **ZFS** (ARC, santé pools), **unités systemd
échouées**, **latence ping**. C'est le plus gros gisement d'amélioration.

- `[x]` **Prérequis réseau** : exposition de l'API InfluxDB aux nœuds — variable `INFLUX_LAN_BIND`
      (binding `${INFLUX_LAN_BIND:-127.0.0.1}:8181:8181` dans `docker-compose.yml`,
      `INFLUX_LAN_BIND=192.168.1.180` dans `.env`). **Validé live** : write+read via l'IP LAN OK.
- `[ ]` Créer le script **`deploiement/60-telegraf-nodes.sh`** (bare-metal, convention numérotée) :
  - `apt-get install telegraf smartmontools lm-sensors`
  - Générer `/etc/telegraf/telegraf.conf` : `[[outputs.influxdb_v2]]` →
    `https://192.168.1.180:8181`, `bucket="raw"`, `organization="influxdb"`,
    `token=${TELEGRAF_INFLUX_TOKEN:-<token admin .env>}`, `tls_skip_verify=true`,
    `global_tags node=<hostname>`
  - Plugins : `smart`, `sensors`, `zfs`, `systemd_units`, `ping`, `disk`/`diskio`/`mem`/`cpu`/`system`
  - `systemctl enable --now telegraf`
- `[ ]` **Nœud pilote** : exécuter sur 1 nœud, vérifier que `smart`/`sensors`/`zfs`/`systemd_units`/
  `ping` arrivent dans la base `raw`. **S'arrêter ici pour validation.**
- `[ ]` **Module web `node-sensors` v1** (Option A — nouvelle famille de plugin, aucun module
  existant touché) : `packages/web/src/plugins/node-sensors/` + flag `USE_PLUGIN_NODE_SENSORS`
  dans `core/config/features.ts` + enregistrement dans `core/plugin/plugins.ts` + i18n
  `nav.nodeSensors` + data-source sur les measurements Telegraf + panneaux températures/SMART/ZFS.
- `[ ]` **Extension** aux autres nœuds + règles d'alarme (SMART critique, température > seuil,
  unité échouée) dans le module `centreonnsca`.

> Token : par défaut le token admin de `.env`, surchargeable via `TELEGRAF_INFLUX_TOKEN`
> (token dédié possible). Telegraf tourne en bare-metal sur le nœud (pas virtualisé).

---

## P1 — Alarme quorum cluster  `[ ]`

Donnée **déjà pollée** (`/cluster/status` expose le quorum) → coût ~0, valeur **critique**
(un nœud qui perd le quorum laisse tourner ses guests mais bloque toute opération).
Modèle : check `system.cluster_quorum` de ProxMenux (CRITICAL).

- `[ ]` Exposer le champ quorum dans le snapshot (poller) + règle d'alarme « quorum perdu ».
- `[ ]` Reflet dans le Health Score (pénalité) et la vue d'ensemble.

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

## P3 — Module « Audit / best-practices »  `[ ]`

Un **2ᵉ score** (configuration) en complément du health score (ressources). La plupart des 43
checks ProxMenux sont **faisables via l'API PVE** avec les données déjà collectées :

- `[ ]` Checks API (données déjà pollées) : `qemu_without_agent`, `privileged_containers`,
  `autostart`, `stuck_snapshots`, `cpu_host_type`, `replication_state`, `bond_members`,
  `bridge_without_ports`, `zfs_arc_max`, `thin_pool_overprovisioning`, `memory_overcommit`
  (déjà fait dans `overcommit.json`).
- `[ ]` Checks agent (via Telegraf, après P0) : `disk_errors`, `disk_service_life`,
  `failed_units`, `pending_reboot`, `security_updates`.
- `[ ]` Page « Audit » : liste des constats par sévérité + score de configuration.

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
