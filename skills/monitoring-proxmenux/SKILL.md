---
name: monitoring-proxmenux
description: Référence de reprise sur le monitoring — analyse du projet ProxMenux (toolkit d'admin Proxmox, lecture seule) comme modèle pour améliorer le monitoring et les graphiques de prox4u, + plan de déploiement Telegraf sur les nœuds Proxmox + audit sécurité ProxMenux. Use when improving prox4u monitoring/graphs, deploying Telegraf on Proxmox nodes, adding the node-sensors plugin, the alarm engine (hysteresis/suppression/ack), the best-practices audit module, or reviewing ProxMenux as a reference.
---

# Monitoring — Référence ProxMenux & plan Telegraf

Base de connaissance de **reprise** sur l'amélioration du monitoring de prox4u, en s'inspirant du
projet **ProxMenux** (`/home/opencode/projet/ProxMenux`, **lecture seule**). ProxMenux est un
toolkit d'admin Proxmox (menu CLI + dashboard web) qui tourne **sur chaque nœud PVE** (AppImage) ;
prox4u est un **poller distant via l'API PVE**. Cette skill documente ce que ProxMenux fait bien,
les écarts avec prox4u, le plan Telegraf, et l'audit sécurité.

> Architecture globale de prox4u : voir le skill `general`. Alarmes Centreon existantes : skill `centreon-nsca`.

## 1. Objectif & posture

- **Améliorer le monitoring + les graphiques** de prox4u sans réécrire le cœur.
- ProxMenux est une **référence** (on s'en inspire, on ne le modifie pas).
- Les métriques locales que l'API PVE ne donne pas (SMART, températures, ZFS, unités systemd,
  latence) sont capturées par **Telegraf en bare-metal** sur chaque nœud Proxmox, poussées dans
  l'InfluxDB 3 Core de prox4u (base `raw`), puis lues par un **nouveau plugin `node-sensors`**.

## 2. Architecture de monitoring ProxMenux (double boucle)

ProxMenux tourne sur le nœud (AppImage) avec deux boucles complémentaires.

### 2.1 Health monitor continu (cycle 5 min + hystérésis)
Fichier : `AppImage/scripts/health_monitor.py` (~6 900 lignes).

- **Hystérésis anti-flapping** (le point clé à reprendre) : on ne se déclenche pas sur un
  instantané mais sur une **durée soutenue**, avec un **seuil de sortie distinct** du seuil
  d'entrée. Ex. CPU :
  - CRITICAL : ≥ 95 % **soutenu 5 min** (fenêtre d'échantillons, ~25 échantillons min)
  - WARNING : ≥ 85 % soutenu 5 min
  - Récupération : < 75 % pendant 2 min (seuil de sortie **plus bas** que le seuil d'entrée)
- Catégories couvertes : CPU, température CPU, RAM, stockage, **SMART disques**, réseau +
  **latence**, VM/CT, services PVE, **logs journalctl**, certificats, fail2ban, ZFS pools,
  montages distants (NFS/CIFS), capacité LXC/VM.

### 2.2 Mécanique d'alerting mature (à reprendre dans le moteur d'alarmes prox4u)
Fichiers : `health_persistence.py`, `health_thresholds.py`, `notification_manager.py`,
`notification_channels.py`.

- **Persistance des erreurs** (SQLite `health_monitor.db`) : survit aux redémarrages/updates.
  **Auto-résolution intelligente** : la condition disparaît (ex. la VM redémarre) → l'erreur se
  ferme seule ; timeout de sécurité 48 h.
- **Suppression par catégorie** : durée configurable par type d'erreur (ne pas ré-alermer en boucle).
- **Acknowledgment manuel** : l'opérateur « acknowledge » une erreur → elle ne remonte plus.
- **Seuils utilisateur** : `health_thresholds.json` = défauts recommandés + overrides utilisateur
  (fichier ne contient que les overrides ; forward-compatible).
- **Notifications multi-canal** : Telegram, Gotify, Discord, Email, Pushover, Apprise (arbitraire)
  + **enrichissement IA** du contexte (fréquence, historique, données SMART, erreurs connues).
- **Canal Telegram** (`notification_channels.py`, `TelegramChannel` §211) : `bot_token` + `chat_id`
  + `topic_id` (supergroup), parse HTML, coupure à 4096 chars, retry, `test()`, et
  **`send_photo(url, caption)`** → on peut envoyer **l'alarme avec sa courbe** (rendu ECharts
  côté serveur). C'est le vrai « combo InfluxDB + Telegram ».

### 2.3 Audit périodique — 43 checks PVE (catalogue)
Fichier : `AppImage/scripts/audit_checks_pve.py` (liste : `grep -n "@register"`). Approche
complémentaire au health monitor : un **audit de configuration/bonnes-pratiques** périodique,
avec profil, politique et preuves. Chaque check a une sévérité (INFO/WARNING/CRITICAL).

Catalogue annoté **faisable via l'API PVE** (données déjà pollées par prox4u) vs **nécessite un
agent nœud** (Telegraf/SSH) :

| Check | Sév. | Source |
|---|---|---|
| `backup.guest_coverage` | CRIT | API (PBS) — module Backups prox4u |
| `backup.last_backup_age` | WARN | API (PBS) |
| `backup.job_results` | WARN | API (PBS) |
| `backup.verification_state` | WARN | API (PBS) |
| `backup.retention_defined` | WARN | API (PBS) |
| `backup.host_recovery` | CRIT | API (PBS) |
| `system.cluster_quorum` | CRIT | **API** — **fait + validé E2E** dans prox4u (métrique `cluster_quorum` + cible cluster + pénalité Health Score −25 + badge + failover endpoint, issue #3 clôturée) |
| `system.failed_units` | CRIT | agent (systemd) — **Telegraf** |
| `system.ha_state` | CRIT | API |
| `system.pending_reboot` | WARN | agent / API limitée |
| `system.time_synchronisation` | WARN | **API** (header `Date` vs serveur) — **P5 prox4u** |
| `system.memory_overcommit` | WARN | **déjà fait** dans prox4u (`overcommit.json`) + ✅ **audit v1 Phase 1** (warn/crit) |
| `system.kernel_current` / `update_chain` / `security_updates` | WARN | agent (apt) |
| `system.swap_configured` / `journal_size` / `boot_loader` | INFO/WARN | agent |
| `security.certificate_expiry` | WARN | **API** (TLS endpoints) — **P5 prox4u** |
| `security.lynis_warnings` / `ssh_root_login` / `host_firewall_enabled` | WARN | agent / API (firewall) |
| `guests.qemu_without_agent` | INFO | **API** (config + agent déjà lus) — ✅ **audit v1 Phase 1** (crit) |
| `guests.privileged_containers` | WARN | **API** (config) — ✅ **audit v1 Phase 1** |
| `guests.autostart` / `cpu_host_type` | INFO | **API** (config) — `cpu_host_type` ✅ **audit v1 Phase 1** (`autostart` = Phase 2) |
| `guests.stuck_snapshots` | WARN | **API** (snapshots déjà lus) |
| `guests.replication_state` | WARN | **API** |
| `storage.zfs_arc_max` / `zfs_scrub_age` | WARN | **API** (`/nodes/{n}/zfs`) |
| `storage.thin_pool_overprovisioning` | WARN | **API** (`/nodes/{n}/disks/lvmthin` déjà pollé) — ✅ **audit v1 Phase 1** (warn/crit) |
| `storage.orphaned_volumes` / `pool_integrity` / `connected_storage` | WARN/CRIT | API |
| `storage.ceph_health` / `array_integrity` | CRIT | API / agent |
| `hardware.disk_errors` / `disk_service_life` | WARN/INFO | **agent (SMART)** — **Telegraf** |
| `network.bond_members` / `bridge_without_ports` | WARN/INFO | **API** (network déjà pollé) — `bridge_without_ports` ✅ **audit v1 Phase 1** (warn) ; `bond_members` = Phase 2 |

→ La grande majorité est **faisable via l'API PVE** avec les données que prox4u collecte déjà ;
seuls SMART / températures / journal / unités systemd / apt exigent un agent (Telegraf).

## 3. Audit sécurité ProxMenux

**Impression** : projet déjà passé par un **audit sécurité systématique** (refs « Audit Tier N #X »
partout dans le code, failles documentées et corrigées). Base solide ; le vrai risque est le
**modèle d'exposition par défaut**.

### 3.1 Ce qui est durci ✅
- **Mots de passe** : PBKDF2-SHA256 **600k itérations** (baseline OWASP) + rehash au vol des
  anciens SHA-256 non salés (`auth_manager.py` §261).
- **Secret JWT** : `secrets.token_urlsafe(48)` aléatoire **par install**, persisté dans
  `auth.json`, audité à la rotation (§160).
- **2FA TOTP** + codes de secours.
- **Rate-limiting login** : 5 tentatives / 300 s + intégration fail2ban (`flask_auth_routes.py`).
- **Scopes** `read_only` / `full_admin` : toute route mutante exige `full_admin`
  (`jwt_middleware.py`).
- **Exécution de scripts** : validation `os.path.realpath` + `os.path.commonpath` → anti-traversée
  **et** anti-symlink (`flask_terminal_routes.py`).
- **Terminal** : ticket single-use vérifié **avant** d'ouvrir le pty / spawner bash.
- **Webhook PVE** : bindé `127.0.0.1` (loopback) uniquement.

### 3.2 Les vrais risques ⚠️ (classés)
1. **Exposition par défaut** (le plus critique) : auth **désactivée par défaut**
   (`"enabled": False`) + serveur bindé **toutes interfaces** (`app.run(host='::', port=8008)`)
   + **fallback HTTP clair** si pas de SSL. Le README propose `http://your-proxmox-ip:8008`.
   → une install fraîche = **shell root + exécution de scripts accessibles au réseau, sans auth,
   en HTTP**. Modèle « verrouille-le toi-même » (auth + SSL + firewall 8008 vers LAN/localhost).
2. **Shell root par design** : le terminal est un `/bin/bash -li` **root** sur le nœud. Un token
   fuilé ou une auth faible = compromis total du nœud.
3. **L'IA envoie les données à l'extérieur** : quand l'enrichissement IA est activé, noms d'hôtes,
   VMs, **sériels de disques**, SMART, messages d'erreur partent vers OpenAI/Anthropic/Gemini/
   OpenRouter. **Ollama (local)** = option sûre à privilégier par défaut.
4. **Certificat auto-signé** → MITM possible sur réseau non maîtrisé.
5. **`auth.json`** (contient `jwt_secret` + `password_hash`) doit être en `600` — à vérifier
   que l'install l'impose.

### 3.3 Leçons pour prox4u
prox4u est **déjà plus prudent** : InfluxDB bindé `127.0.0.1` par défaut (LAN seulement pour
Telegraf, token requis, HTTPS), module d'auth (users/groups dans `data/auth.json`). À conserver :
- Ne jamais shipper **auth-off + bind toutes interfaces + HTTP**.
- **Scopes lecture vs opération** dès la Phase 3 (start/stop/reboot).
- **Validation des chemins/commandes** si exécution côté nœud.
- **IA : Ollama local par défaut**, cloud en opt-in explicite (ne pas envoyer SMART/hôtes par défaut).
- **Rate-limiting + 2FA** sur le login (à ajouter si absent).

## 4. Écarts prox4u vs ProxMenux (ce qu'on reprend)

prox4u (poller distant API PVE) a déjà : health score déterministe, PRA, capacity planning,
historique InfluxDB (raw 5 s / consolidated 5 min), alarmes Centreon (moteur ok⇄firing 15 s).

- **Via l'API PVE seule** (données déjà pollées, coût faible) : **quorum** (✅ fait + **validé E2E**
  — issue #3 clôturée : métrique `cluster_quorum` + cible cluster + pénalité Health Score −25 + badge
  rouge/vert + **failover d'endpoint** (nœud endpoint down → bascule sur l'autre nœud, champ `apiVia`)
  + **note Qdevice** (cluster 2 nœuds + Qdevice : 1 nœud down seul ne perd pas le quorum, l'app lit
  `quorate` PVE 9 = la vérité)), **certificats**
  (expiration TLS endpoints), **drift NTP** (header `Date`), **audit best-practices** (✅ **Phase 1
  livrée + validée E2E** — issue #6 : module `audit` v1, 7 checks API (agent manquant, CT
  privilégiés, cpu=host, bridges sans port, thin pool sur-alloué, RAM sur-allouée, versions PVE
  hétérogènes) + **2ᵉ score de configuration** + page `/audit` + constats cliquables — voir skill
  `audit` ; restent autostart, snapshots bloqués, bonds, ARC ZFS (Phase 2) + checks agent Telegraf
  (Phase 3)).
- **Nécessite un agent nœud = Telegraf** : **SMART** (détection prédictive), **températures**,
  **journal/erreurs**, **unités systemd échouées**, **latence ping**.
- **Mécanique d'alarmes à renforcer** : **hystérésis de sortie** (seuil de récupération distinct),
  **suppression par règle**, **acknowledgment**, **auto-résolution**, **seuils du health score
  externalisés** (`overcommit.json` hot-reload = bon pattern à étendre).
- **Canaux natifs** (Telegram…) + **enrichissement** avec l'historique InfluxDB (courbe dans
  l'alarme via `send_photo`).

## 5. Décisions actées & plan Telegraf

### 5.1 Arbitrages (validés)
- Fichier d'actions `MONITORING-ACTIONS.md` à la **racine** de prox4u.
- **Token Telegraf** : réutilise le **token admin** de `.env` par défaut, mais **choix dans la
  config** — paramètre `TELEGRAF_INFLUX_TOKEN` surchargeable (token dédié possible).
- **Nouveau module web = Option A** : nouvelle **famille de plugin `node-sensors` (v1)** (page
  dédiée températures/SMART/ZFS/unités/latence par nœud). **Aucun module existant touché** →
  protège l'existant. (`hypervision_v2` seulement si on veut embarquer les panneaux dans la page
  détail nœud plus tard — convention `module-versions.ts` : jamais de modif en place.)
- **Telegraf en bare-metal** sur les nœuds Proxmox (pas virtualisé) → accès direct
  SMART/capteurs/ZFS/systemd du host.

### 5.2 Préréquis déjà posés (session 04/11/2026)
- **`INFLUX_LAN_BIND`** : le port 8181 InfluxDB était lié `127.0.0.1` uniquement → Telegraf ne
  pouvait pas écrire. Ajout du binding `${INFLUX_LAN_BIND:-127.0.0.1}:8181:8181` dans
  `docker-compose.yml` + `INFLUX_LAN_BIND=192.168.1.180` dans `.env` (interface `enp6s18`).
  **Validé live** : écoute 127.0.0.1 **et** 192.168.1.180, write+read via LAN OK.
- Auto-détection de l'IP LAN dans `deploiement/30-env-setup.sh`.

### 5.3 Script de déploiement `deploiement/60-telegraf-nodes.sh` (livré, déployé sur les 3 nœuds)
- `apt-get install telegraf smartmontools lm-sensors` + auto-détection des devices SMART via
  `smartctl --scan`
- Génère `/etc/telegraf/telegraf.conf` :
  - `[[outputs.influxdb_v2]]` → `urls=["https://192.168.1.180:8181"]`, `bucket="raw"`,
    `organization="influxdb"`, `token=${TELEGRAF_INFLUX_TOKEN}` (requis), `insecure_skip_verify=true`,
    `timeout=10s`
  - `global_tags` : `node=<hostname>` (distingue chaque nœud)
  - Plugins : `smart`, `sensors`, `zfs`, `systemd_units`, `disk`/`diskio`/`mem`/`cpu`/`system`
    (ping ICMP commenté — à réactiver si CAP_NET_RAW disponible)
  - Override systemd `User=root` (accès aux devices raw pour smartctl)
- `systemctl enable --now telegraf` + self-test. Idempotent (`--dry-run`, `.bak.<ts>` du conf).
- **Déployé** sur `proxmox` (192.168.1.80), `ProxSite1`, `ProxSite2` — 9 tables actives dans
  `raw` (ProxSite2 sans capteurs, `sensors` vide — normal).

### 5.4 Module web `node-sensors` v1 (Option A, livré)
- `packages/web/src/plugins/node-sensors/` — manifest `id:'node-sensors'`, route `/node-sensors`
  + menu (order 70, icône `Thermometer`)
- Flag `USE_PLUGIN_NODE_SENSORS` dans `core/config/features.ts` (défaut ON, opt-out)
- Enregistrement dans `core/plugin/plugins.ts` + `DEFAULT_MODULES` (shared/auth.ts)
- i18n `nav.nodeSensors` + `nodeSensors.*`
- Routeur `packages/server/src/modules/nodesensors/` : `GET /api/node-sensors` (cache 1 min,
  try/catch par section, dernier point par clé) + consolidation 15 min dans `influx-consolidator.ts`
- Détail complet : skill `node-sensors`

## 6. Chemins clés (navigation rapide)

**ProxMenux (lecture seule)** :
- `AppImage/scripts/health_monitor.py` (~6 914 lignes) — health monitor + hystérésis
- `AppImage/scripts/audit_checks_pve.py` — 43 checks (`grep -n "@register"`)
- `AppImage/scripts/notification_channels.py` — canaux (`TelegramChannel` §211, `send_photo`)
- `AppImage/scripts/health_persistence.py` / `health_thresholds.py` — persistance + seuils
- `AppImage/scripts/flask_server.py` (1 Mo) — `app.run(host='::',port=8008)` §23876
- `AppImage/scripts/auth_manager.py` — PBKDF2 §261, secret JWT §160, SSL §1420
- `AppImage/scripts/jwt_middleware.py` — scopes read_only/full_admin

**prox4u (cible)** :
- `packages/shared/src/health.ts` — health score · `module-versions.ts` — versionnement plugins
- `packages/web/src/core/plugin/{plugins.ts,types.ts}` — enregistrement/contrat plugins
- `packages/web/src/core/config/features.ts` — feature flags
- `packages/server/src/core/influx.ts` — écriture `/api/v3/write_lp?db=raw`
- `packages/server/src/modules/centreonnsca/` — moteur d'alarmes existant (ok⇄firing)
- `deploiement/` — scripts numérotés (10 token, 40 TLS, 50 influx, **60 telegraf livré**)
- `MONITORING-ACTIONS.md` (racine) — TODO priorisée (P0 Telegraf → P5 certificats/NTP)
