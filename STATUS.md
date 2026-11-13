# Prox4u — État d'avancement

> **Dernière mise à jour : 2026-11-06**
> Application de supervision vCenter-like pour Proxmox VE (managers/DSI).
> Conception de référence : `.opencode/skills/proxmox-web/SKILL.md`

## Lancer le service

```bash
./up.sh                                  # démarrage complet : InfluxDB (Docker) + Explorer + application
./server.sh start|stop|restart|status    # application seule → https://localhost:8080
```

- App en **HTTPS** (cert auto-signé, SAN localhost + IP VM) ; InfluxDB en HTTPS sur 8181 ; **Explorer** (UI InfluxDB 3) en HTTPS sur 8888
- Logs / pid : `logs/` (à la racine du projet, rien dans /tmp)
- Cron : `@reboot` + keepalive minute par minute sur `server.sh start` (idempotent) ; le conteneur InfluxDB se relance seul au boot (`restart: unless-stopped`)
- Dev (hot reload) : `pnpm dev` · Build : `pnpm build` · Vérif : `pnpm typecheck && pnpm test` (313 tests : 217 shared + 96 server)

---

## ✅ Fait — Phase 1 « Écran d'accueil Manager » (livrée, vérifiée sur le cluster réel)

### Monorepo & stack
- pnpm workspaces : `packages/shared` (types + logique pure), `packages/server` (Fastify + TS), `packages/web` (Vite + React 18 + Tailwind v4)
- Graphiques : Tremor 3.18.7 (aire, donut, barres) + ECharts 6 (jauge, projections pointillées, markArea seuils)
- i18next FR/EN (toggle dans la topbar), thème clair shadcn-style

### `packages/shared`
- Types complets (snapshot dashboard, KPI, PRA, capacité, alertes…)
- Logique pure testée : **health score** (pénalités déterministes), **PRA N-1 multi-site** (allocation CPU/RAM toutes VMs, disk exclu), **capacity planning** (régression linéaire 30 j, jours avant 90 %)
- Clés i18n FR/EN · **20 tests vitest passants**

### `packages/server`
- `proxmox-client.ts` : API PVE 9 (token `PVEAPIToken`, TLS auto-signé géré) — `/cluster/status`, `/cluster/resources`, `/nodes/{n}/status`, `/storage`, `/pools`, `rrddata`
- `poller.ts` : tick 5 s, snapshot agrégé, tampon journalier 30 j (backfill RRDDATA au démarrage), top consommateurs, agrégats pools, alertes
- `ws-hub.ts` : push WebSocket `/ws` (snapshot immédiat + push 5 s)
- Routes REST : `/api/health`, `/api/dashboard`, `/api/capacity` (cache 5 min), `/api/trends` (cache 5 min)
- SPA servie par Fastify (`packages/web/dist`)
- `mock-source.ts` : 3 scénarios (nominal / dégradé / critique) — 2 bâtiments × 3 nœuds, PRA ok/warn/crit, nœud down → `MOCK=true MOCK_SCENARIO=…`

### `packages/web` — dashboard
- **Health Score** : jauge ECharts + libellé Nominal/Dégradé/Critique + détail des pénalités
- **4 KPIs** : nœuds actifs · allocation CPU/RAM (barres) · stockage (% + To libres) · VMs en marche/arrêtées
- **PRA N-1** : jauges d'absorption par site 🟢🟠🔴 + bannière globale (mono-site → « non applicable »)
- **Capacity planning 30 j** : 3 courbes lissées + projections pointillées + bandes seuils 80/90 % + badges « à 90 % dans ~X j » / pente
- **Top 5 consommateurs** : table par VM (nœud, pool, CPU, RAM) + barres par pool (équipe)
- **Tendance 7 j** : aire lissée CPU/RAM cluster + donut répartition OS/types
- **Santé des nœuds** : table (état, CPU, RAM, disque système, uptime)
- **Alertes actives** : liste visuelle (nœud down, seuils, PRA)

### Vérifications effectuées
- `pnpm typecheck` + `pnpm test` + `pnpm build` : OK
- Rendu réel validé par capture headless (Chromium/Playwright) : dashboard complet sur données réelles, **zéro erreur console**
- WS validé : snapshot immédiat + push 5 s · Mock validé sur les 3 scénarios
- Cluster réel branché : nœud `proxmox` online, score 100, stockage 26 % (2.8/10.8 To), 4 VMs

### Bugs notables corrigés (à retenir)
| Bug | Cause / fix |
|---|---|
| Nœuds non détectés | PVE 9 : `/cluster/status` renvoie `name` (pas `node`) |
| `no-details` inconnu | PVE 9 a retiré le paramètre sur `/cluster/resources` |
| Graphiques Tremor noirs/gris | Classes de couleur générées **à l'exécution** (`fill-blue-500`…) → `@source inline("…")` dans `index.css` + tokens sémantiques `tremor-*` dans `@theme` |
| Barres/aire débordantes | Root Tremor impose `h-80` → passer la hauteur en prop `className="h-40"` (twMerge) |
| Graphe capacité vide | `useEChart` initialisait au mount alors que le div n'existait qu'après l'arrivée des données → init paresseux |
| i18n non interpolé | i18next exige `{{var}}` (double accolade) |
| pnpm 12 refusait les build scripts | `allowBuilds: esbuild: true` dans `pnpm-workspace.yaml` |

### Opérations
- `server.sh` à la racine : start/stop/restart/status, idempotent, logs dans `logs/server.log`
- Config : `.env` (PVE_URL, PVE_USER, PVE_REALM, PVE_TOKEN_ID, PVE_TOKEN_VALUE, MOCK, MOCK_SCENARIO, PORT)
- Topologie sites : `sites.json` (actuellement 1 site « Site principal » → nœud `proxmox`)

---

## ✅ Fait — InfluxDB 3 Core + TLS + déploiement Docker (livré, validé de bout en bout sur la VM)

### Historique des métriques dans InfluxDB
- **Docker Compose** : image `influxdb:3.11.5-core`, port 8181 (HTTPS), conteneur **non-root** (`user: ${INFLUX_UID:-1500}:${INFLUX_GID:-1500}`), token admin en secret bind-mount
- **Double base** : `raw` (rétention 31 j, écriture du poller toutes les 5 s) + `consolidated` (rétention ∞, fenêtres 5 min agrégées par `influx-consolidator.ts`)
- **Lecture API** : InfluxDB d'abord (`date_bin`), repli RRD Proxmox si base vide + champ `source` dans la réponse + badge UI
- Particularités 3 Core retenues : pas d'org/bucket (concepts v2), `/api/v3/query_sql` en JSON `{db, q}`, Bearer exigé même sur `/health`, timestamps UTC sans suffixe → parser comme UTC (`influxTsToUnix`)

### TLS partout
- App (8080) + InfluxDB (8181) en HTTPS, certs auto-signés 10 ans avec SAN (`localhost`, `127.0.0.1`, `VMIA`, `192.168.1.180`, `192.168.100.180`)
- `scripts/tls-init.sh` (certs, `TLS_SAN_EXTRA`) · `scripts/influx-init.sh` (token admin + sync `.env`)
- L'app fait confiance au CA InfluxDB local via `INFLUX_CA_CERT` (undici) ; un client externe doit accepter le cert auto-signé

### Déploiement & opérations
- **TOUT dans le répertoire projet** (pas de named volumes) : `data/tls/`, `data/influxdb/` (chown 1500:1500), `data/explorer/` (chown 1500:1500), `data/consolidation-state.json`
- `up.sh` : prérequis (env, certs, token, ownership) → conteneur → attente `/health` → Explorer (optionnel) → app
- **Explorer** (`influxdata/influxdb3-ui:1.9.0`, mode admin, port 8888 HTTPS) : UI officielle InfluxDB 3 — requêtes SQL + visualisations ; connexion préconfigurée dans `data/explorer/config/config.json` vers `https://influxdb:8181` (SAN `DNS:influxdb` dans le cert) ; clé de session `EXPLORER_SESSION_KEY` dans `.env` ; HTTPS via env `SSL_CERT_PATH`/`SSL_KEY_PATH` (certs montés sur `/etc/nginx/ssl/{cert,key}.pem`)
- Stockage UTC / affichage heure locale du navigateur (choix acté, voir skill §8)

### Validation E2E sur la VM (`VMIA`)
- Conteneur healthy, écritures temps réel dans `raw` (quelques secondes d'ancienneté), consolidateur actif, tous les endpoints API en `source: influx`
- Accès réseau validé : `https://192.168.1.180:8181/health` et `https://VMIA:8181/health` → 200

### Pièges rencontrés (corrigés — ne pas réintroduire)
| Piège | Fix |
|---|---|
| Crash loop conteneur : user non-root ne lit pas la clé TLS en 600 | clés TLS en **644** (`tls-init.sh` génère ainsi) |
| Crash loop conteneur : `data/influxdb/` owned par l'hôte | `chown -R 1500:1500 data/influxdb` + user hôte `influxdb` (uid/gid 1500) |
| Conflit d'ownership sur l'état du consolidator | état dans `data/consolidation-state.json`, **hors** de `data/influxdb/` |
| Décalage 2 h sur les graphiques | InfluxDB renvoie des ISO sans suffixe → `influxTsToUnix` (parse UTC) |
| `server.sh` healthcheck en http:// alors que l'app sert HTTPS | `server.sh` lit `TLS_CERT` du `.env` → https + `--cacert` |
| Explorer : image `influxdb3-ui:1.11.0` introuvable sur Docker Hub | tag stable le plus récent = **1.9.0** (vérifier les tags avant de pinner) |
| Explorer : HTTPS silencieux en HTTP-only si certs mal montés | l'entrypoint attend les env **`SSL_CERT_PATH`/`SSL_KEY_PATH`** (montés sur `/etc/nginx/ssl/{cert,key}.pem`, chemins exacts de nginx.conf) ; sinon il coupe le bloc HTTPS et écoute 8080 |
| Explorer : crash au démarrage « /db not writable » | `data/explorer/` doit être chown **1500:1500** (conteneur non-root `influxui`, idem InfluxDB) |

---

## ✅ Fait — Multi-cluster / nœuds autonomes + menu gauche (livré, typecheck/build/tests OK)

### Config `clusters.json`
- `clusters.json` (chmod 600, **gitignored**) : liste d'endpoints `{id, name, url, token}` (token API inline `user@realm!tokenid=value`) ; template commité `clusters.example.json`
- Repli mono-endpoint : sans `clusters.json`, un endpoint `default` est construit depuis `PVE_*` du `.env` (comportement d'avant conservé)
- Validation zod fail-fast au démarrage (URL/token invalides → crash explicite, pas de demi-démarrage)
- `sites.json` : champ `endpoint` rattache chaque site/bâtiment à son endpoint (PRA par endpoint)

### Backend
- `config.ts` : `EndpointConfig[]` + `defaultEndpointId` ; `proxmox-client.ts` instancié **par endpoint**
- `poller.ts` réécrit multi-endpoints : état isolé par endpoint (snapshot, buffer journalier 30 j, lastError), tick **parallèle**, snapshot global `MultiDashboardSnapshot` ; un endpoint en panne n'impacte pas les autres
- `ws-hub.ts` : push `MultiDashboardSnapshot` (tous les endpoints + défaut)
- Routes : `/api/dashboard` (multi), `/api/endpoints` (liste compacte pour la sidebar), `/api/capacity|trends|metrics?endpoint=<id>[&node=<n>]` (404 si id inconnu) ; caches par endpoint (+ nœud pour metrics)
- Snapshot enrichi : `NodeHealth` porte ip/cpus/mem/loadavg/version ; `DashboardSnapshot.vms[]` (compactes, par nœud) pour la page nœud
- InfluxDB : tag `cluster` sur chaque écriture ; consolidator `GROUP BY t, cluster, node(, vmid, name)` ; requêtes filtrées `WHERE cluster = ?` avec `COALESCE(cluster, '<defaultId>')` pour les lignes legacy (pas de backfill RRD)
- Mock : 2 endpoints démo (`demo-a` 2 bâtiments/6 nœuds, `demo-b` 1 bâtiment/2 nœuds) — `MOCK=1`

### Frontend
- `react-router-dom@^6` : `/` → vue d'ensemble, `/e/:endpointId` → dashboard complet de l'endpoint (ancienne page `dashboard.tsx` remplacée par `pages/endpoint.tsx`)
- **Sidebar** (`components/layout/sidebar.tsx`) : logo, « Vue d'ensemble », section « PROXMOX » (une entrée par endpoint avec dot de statut 🟢/🟠/🔴 + score, sous-entrées par nœud), footer état WS
- **Topbar** réécrite : santé globale (pire label + min des scores), compteur serveurs Proxmox/nœuds, badges mock/WS, contrôles langue/thème/layout
- **Terminologie UI** : « Endpoint(s) » jamais affiché → « Proxmox » / « Serveurs Proxmox » (FR/EN) ; le terme technique reste en interne (code, config, API)
- `pages/overview.tsx` : KPIs agrégés pondérés (`aggregateKpis`), cartes santé par endpoint, alertes union préfixées par endpoint, table endpoints (nœuds, VMs, score)
- **Page nœud** (`pages/node.tsx`, route `/e/:endpointId/n/:nodeId`) : KPIs CPU/RAM/disk/charge du nœud, historique CPU/RAM/réseau (`/api/metrics?node=`), VMs hébergées ; sous-entrées par nœud dans la sidebar (dot de sévérité)
- **Surallocation (overcommit)** : `KpiSummary.cpuAllocatedCores/ramAllocatedBytes` + `NodeHealth.cpuAllocCores/ramAllocBytes` (Σ allocations VMs, templates exclus) ; carte `OvercommitCard` du dashboard endpoint, colonnes « CPU × / RAM × » de la vue d'ensemble, badges dans l'en-tête page nœud. Teintes : ≥2× warn, ≥3× crit
- Store/hooks : état multi dans `store/dashboard.ts` (`multi`, données lourdes par endpoint id), `useMulti()` / `useEndpoint(id)` ; `loadHeavy(endpointId)` au montage + refresh 5 min

### Vérifications effectuées
- `pnpm typecheck` + `pnpm test` (20 shared + 24 server) + `pnpm build` : OK
- Smoke test mock (`MOCK=1`) : `/api/dashboard` multi, `/api/endpoints`, metrics/capacity par endpoint, 404 endpoint inconnu, fallback `defaultEndpointId` en mode mock
- **Validé sur le cluster réel** : endpoint `proxmox` (clusters.json) online, score 100, 5/6 VMs ; `/api/metrics?endpoint=proxmox` en `source: influx` ; SPA `/` et `/e/proxmox` en 200 ; écritures InfluxDB taggées `cluster=proxmox` (lignes legacy sans tag lues via COALESCE)
- **Surallocation validée** : cluster réel `proxmox` → CPU ×1.46 (35 vCPU / 24 cœurs), RAM ×0.62 (84/135 Go) ; nœuds ClusterProxmox sans VMs → ×0.00 ; mode mock cohérent (×0.1–0.9 selon charge simulée)

### Pièges rencontrés (corrigés)
| Piège | Fix |
|---|---|
| `@proxmox/shared` résolu via son **dist** (tsup) par server/web | rebuilder shared après toute modif de types, sinon typecheck server/web sur du dist périmé |
| Mode mock : `defaultEndpointId` de `clusters.json` (`proxmox`) absent de la liste mock | fallback au 1er endpoint dans `index.ts` si le default n'existe pas |
| Cluster multi-nœuds compté « 2/3 nœuds » + score pénalisé | `/cluster/status` renvoie en 1re entrée le **cluster lui-même** (sans `online`) sur un vrai cluster → filtrer `type === 'node'` dans `getNodes()` et `getStorage()` (inexistant sur un nœud standalone) |
| `loadavg` renvoyé par l'API PVE en **tableau de chaînes** (`["1.62","2.17","1.95"]`) → crash `.toFixed` côté navigateur | helper `loadavg()` dans `proxmox-client.ts` (conversion via `num()`, qui accepte désormais les nombres en chaîne) ; tuple `[number, number, number] \| null` garanti |

---

## ✅ Fait — Politique de surallocation externalisée (`overcommit.json`) (livré, validé mock + cluster réel)

### Fichier de config `overcommit.json` (racine, commité)
- Source unique des **ratios de surallocation** (échelles par ressource) ET du **code couleur d'usage** :
  ```json
  { "usage": { "warnPct": 70, "critPct": 90 }, "hostRamProvisionPct": 10,
    "cpu": { "okMax": 2, "warnMax": 4 }, "ram": { "okMax": 1, "warnMax": 1.2 },
    "disk": { "okMax": 1, "warnMax": 1.5 } }
  ```
- Sémantique : `ratio ≤ okMax` → 🟢 · `≤ warnMax` → 🟠 · au-delà 🔴 (bornes incluses côté OK/warn)
- **Hot-reload sans restart** : mtime vérifié à chaque tick du poller (5 s) ; fichier modifié et valide → appliqué + log ; invalide → config précédente conservée + warning (pas de retry tant que le mtime ne change pas) ; absent au démarrage → defaults intégrés
- Validation zod fail-fast au démarrage (même pattern que `clusters.json`)

### Formules actées (remplacent l'échelle unique <2×/≥2×/≥3× de la Phase 1)
| Ressource | Formule | 🟢 | 🟠 | 🔴 |
|---|---|---|---|---|
| CPU | Σ vCPU alloués / cœurs physiques | ≤ 2× | 2–4× | > 4× |
| RAM | (Σ maxmem + provision hôte 10 %) / RAM physique | ≤ 1× | 1–1.2× | > 1.2× |
| Disk | Σ maxdisk / capacité pools thin (LVM-thin/ZFS/Ceph RBD) | ≤ 1× | 1–1.5× | > 1.5× (« — » si aucun thin) |

- Provision hôte RAM : constante `hostRamProvisionPct` (défaut 10 %) dans le numérateur — vision prudente, cohérente avec le PRA
- Disk : dénominateur = Σ total des datastores **thin uniquement** (`THIN_STORAGE_TYPES` dans shared) ; sans sens sur stockage thick → « — »

### Implémentation
- `shared/overcommit.ts` : types + fonctions pures testées (`overcommitTone`, `usageSeverity`, `computeOvercommit`, `isThinStorage`) — **14 tests** ; `KpiSummary.diskAllocatedBytes` / `diskThinTotalBytes` ; `MultiDashboardSnapshot.overcommit` (poussé en WS)
- Server : chargement + hot-reload dans `config.ts` (`reloadOvercommitConfig` appelé à chaque tick du poller) ; sévérité des nœuds pilotée par la config
- Web : **plus aucun seuil codé en dur** — hook `useOvercommitConfig()` ; `OvercommitCard` 3 blocs (barres à échelles propres, pleine à 2× la borne crit), colonnes CPU ×/RAM ×/Disque × de la vue d'ensemble, badges page nœud, KPIs/barres/table nœuds/storage/bandes du graphe capacité tous lisent la config
- `severityForPct` supprimé (doublon) ; `THRESHOLDS` conservé pour les formules déterministes health score / PRA (seuils fixes documentés)

### Vérifications effectuées
- `pnpm typecheck` + `pnpm test` (34 shared + 24 server) + `pnpm build` : OK
- Smoke mock (8090) : config dans le snapshot, hot-reload validé (modif → appliqué en <5 s), fichier invalide → config précédente conservée + warning, restauration → rechargée
- **App réelle redémarrée** : cluster `proxmox` → disk ×0.34 (4/11.8 To thin), config bien poussée

### Pièges rencontrés (corrigés)
| Piège | Fix |
|---|---|
| `health.test.ts` en décalage avec les champs `NodeHealth`/`KpiSummary` ajoutés au jalon multi-cluster (typecheck cassé avant ce travail) | fixtures complétées (cpus, mem*, loadavg, allocations) |

---

## ✅ Fait — Drag & drop + resize des blocs sur les deux pages (livré, validé en navigateur)

### Problème signalé
« Les graphiques doivent être déplaçables et redimensionnables — cela n'est pas le cas. » Diagnostic : la **vue d'ensemble (`/`, page d'accueil) n'avait aucune grille** (CSS grid statique) ; le dashboard endpoint fonctionnait déjà mais avec une mauvaise visibilité des poignées + un bug CSS qui écrasait nos overrides.

### Corrections
- **Vue d'ensemble (`overview.tsx`)** : passage en `ResponsiveGridLayout` (mêmes réglages que l'endpoint : 12 colonnes, rowHeight 90, marge 16) — 4 KPIs + cartes endpoints (dynamiques `ep-<id>`, 3/rangée) + alertes + table, tous déplaçables/redimensionnables
- **Layout par défaut calculé** pour la vue d'ensemble (`overviewDefaultLayout` : positions des cartes endpoints dérivées du nombre d'endpoints) **fusionné avec les positions persistées** — un nouvel endpoint reprend son emplacement naturel sans écraser le travail de l'utilisateur ; memo stabilisé sur les ids (pas de re-layout à chaque push WS 5 s)
- **Cartes endpoint de la vue d'ensemble** : plus de `<Link>` sur toute la carte (qui annulait le drag via `cancel: a`) — seul le titre est cliquable, en-tête `draggable`
- **Bug CSS (les deux pages)** : `main.tsx` importait `index.css` AVANT `react-grid-layout/css/styles.css` → nos overrides sombres (placeholder indigo au lieu du rouge, poignée 14 px) étaient silencieusement écrasés par le CSS de base. Ordre inversé.
- **Visibilité** : poignée de resize visible en permanence (opacité 0,45 → 1 au survol, au lieu d'invisible jusqu'au hover) ; curseur grab/grabbing sur les en-têtes

### Vérifications effectuées (Playwright, instance mock HTTP 8090)
- Vue d'ensemble : drag ✓ (carte Démo A déplacée), resize ✓ (KPI Stockage 300×196 → 511×302), **persistance après reload ✓** (positions identiques, 8/8 items), bouton « Réinitialiser la disposition » ✓
- Dashboard endpoint : drag ✓, resize ✓, placeholder indigo pendant le drag ✓ (overrides CSS bien appliqués : poignée 14 px / opacité 0,45)
- `pnpm typecheck` + `pnpm test` (34 shared + 24 server) + `pnpm build` : OK ; app réelle redémarrée (8080)

### Pièges rencontrés (corrigés)
| Piège | Fix |
|---|---|
| `<Link>` sur toute la carte endpoint → mousedown dans un `<a>` annule le drag (`cancel` selector) | titre seul cliquable, en-tête `draggable` |
| `layouts` recalculé à chaque push WS (nouvelle identité d'objet) → risque de re-layout pendant un drag en cours | memo sur la clé des ids endpoints + objet `layouts` memoïsé |
| Import CSS RGL après `index.css` → overrides écrasés (même spécificité, cascade) | ordre inversé dans `main.tsx` |

---

## ✅ Fait — Procédure de déploiement sur serveur externe (livré, tarball testé de bout en bout)

### Périmètre (arbitrages utilisateur)
App déployée **hors infrastructure Proxmox** (serveur dédié), **sans git** pour l'instant (transfert par tarball), doc **FR/EN**. Objectif : zéro GUI — comptes et tokens créés par commandes.

### Livrables
- **`deploiement/10-proxmox-token.sh`** (root sur chaque PVE, idempotent, `--dry-run`) : rôle `ManagerReader` (`DA.Read,DA.Audit,VM.Audit,Sys.Audit,SDA.Audit,SDI.Audit,SN.Audit` — 100 % lecture seule, calibré sur les endpoints de l'app) + user dédié `manager@pve` + token API (`--privsep 0`) + ACL datacenter + **auto-test** (`/cluster/resources` → DA.Read, `/nodes/{n}/status` → Sys.Audit) ; valeur du token affichée une seule fois avec les 3 champs `clusters.json` + commande de rotation
- **`deploiement/20-package-release.sh`** : build + tarball daté dans `releases/` (source + `dist/` pré-buildé, exclusions secrets/état, **garde-fou** qui abandonne le paquet si un fichier sensible est détecté)
- **`deploiement/DEPLOY.md`** (FR/EN) : 9 étapes — prérequis réseau (sortant 8006, entrant 8080), tokens PVE, transfert tarball, user dédié `proxmox`, config locale (`.env`, TLS avec SAN = IP du serveur, InfluxDB init), endpoints (`clusters.json` 600 + `sites.json` + `overcommit.json`), démarrage + vérifications, systemd, opérations courantes (mise à jour, rotation token, sauvegarde `data/`)
- **`deploiement/proxmox-manager.service`** : unit systemd (user `proxmox`, `WorkingDirectory=/opt/proxmox-manager`, `Restart=always`) ; InfluxDB/Explorer déjà en `restart: unless-stopped` dans le compose
- README : prérequis + structure mis à jour (pointeurs `10-proxmox-token.sh` / `DEPLOY.md`)

### Vérifications effectuées
- `10-proxmox-token.sh --dry-run` : commandes affichées copiables (`printf %q`), idempotence simulée ✓ — **à exécuter sur le PVE réel au prochain déploiement** (pas d'accès shell PVE depuis la machine de dev)
- **Simulation serveur cible complète** : tarball → extraction dans un répertoire propre → `pnpm install --prod` → démarrage mock → `/api/health` 200 + endpoints OK ✓
- `pnpm typecheck` + `pnpm test` (34 shared + 24 server) + `pnpm build` : OK

### Pièges rencontrés (corrigés)
| Piège | Fix |
|---|---|
| Serveur frais : crash au démarrage (`ENOENT data/tls/influxdb-cert.pem`) même avec InfluxDB désactivé — le CA était chargé dès que `INFLUX_CA_CERT` était renseigné, or `.env.example` le pré-remplit et `data/` est hors tarball | `index.ts` : `trustInfluxCa` uniquement si `config.influx.enabled` (cohérent avec « InfluxDB optionnel » du README) — détecté par la simulation de déploiement |
| Malentendu « deux backends Proxmox » → implémentation de 2 tokens (`full`/`history`) alors que l'utilisateur voulait **deux buckets InfluxDB** — qui existent déjà (`raw` 31 j toutes métriques + `consolidated` ∞ 5 min, consolidateur auto) | Revert complet du dual token (script, config, client, template, tests, docs) ; ajout d'une sous-section FR/EN dans DEPLOY.md §5 documentant les deux bases InfluxDB |

---

## ✅ Fait — Scripts à noms parlants + ordre numéroté (livré, docs FR/EN à jour)

### Périmètre (arbitrage utilisateur)
« Il faut des noms parlants : action sur Proxmox → `proxmox` dans le nom, action sur InfluxDB → `influxdb`, et si ordre → numéroter. Un humain doit comprendre facilement l'organisation et lors d'exécution. » + validation des propositions A/B/C/D de la veille.

### Renommage (numéro = ordre d'exécution DEPLOY.md, pas de 10 pour insérer)
| Avant | Après | Machine |
|---|---|---|
| `scripts/pve-token.sh` | **`scripts/10-proxmox-token.sh`** | chaque serveur Proxmox (§2) |
| `scripts/package.sh` | **`scripts/20-package-release.sh`** | machine de dev (§3) |
| — (nouveau, prop. A) | **`scripts/30-env-setup.sh`** | serveur app (§5) |
| `scripts/tls-init.sh` | **`scripts/40-tls-init.sh`** | serveur app (§5) |
| `scripts/influx-init.sh` | **`scripts/50-influxdb-init.sh`** | serveur app (§5) |

`up.sh` / `server.sh` (racine) conservés : commandes d'opération courante, pas des étapes numérotées.

### Améliorations A/B/C/D
- **A — `30-env-setup.sh [user]`** : crée `.env` depuis le template s'il est absent ; remplit `INFLUX_UID`/`INFLUX_GID` (uid/gid du user cible, défaut user courant) et `EXPLORER_SESSION_KEY` (`openssl rand -hex 32`) si vides/`CHANGE_ME` — **jamais écrasés** si déjà définis à une autre valeur ; affiche les étapes suivantes.
- **B — compose** : port API InfluxDB `8181:8181` → **`127.0.0.1:8181:8181`** (l'app se connecte en localhost, l'API n'est plus exposée au réseau ; Explorer passe par le service Docker `influxdb:8181`, 8888 reste ouvert).
- **C — `up.sh`** : refuse de démarrer Explorer si `EXPLORER_SESSION_KEY` vide/`CHANGE_ME` (message explicite avec la commande à utiliser) au lieu de lancer une UI d'admin avec clé faible.
- **D — DEPLOY.md §7** : vérifications attendues côté InfluxDB (`docker compose ps` healthy + log « InfluxDB prêt : bases raw (31 j) + consolidated (∞) ») + mention du binding 8181 localhost ; §5 réécrit avec la séquence numérotée.

### Vérifications effectuées
- `bash -n` sur chaque script ✓ · `10-proxmox-token.sh --dry-run` ✓ · `30-env-setup.sh` testé dans un répertoire temporaire (pas sur le `.env` réel de dev) ✓
- grep final : plus aucune occurrence des anciens noms dans les fichiers vivants ✓
- `docker compose config` valide après le binding 8181 ✓ · conteneur InfluxDB recréé + health re-vérifié ✓
- Pas de code TS touché → pas de typecheck/test requis

### Pièges rencontrés (corrigés)
| Piège | Fix |
|---|---|
| `30-env-setup.sh` écraserait un `INFLUX_UID/GID` déjà personnalisé (ex. machine de dev `1500`) et casserait la cohérence avec l'ownership de `data/` | valeur du template (`1500`) ou vide → remplacée ; **autre valeur conservée** + avertissement |

---

## ✅ Fait — Dossier `deploiement/` : kit de déploiement regroupé (livré, tarball re-testé)

### Périmètre (arbitrage utilisateur)
Regrouper dans un sous-répertoire `deploiement/` **tous** les fichiers et procédures du déploiement — c'est **un livrable autonome** : procédure + tous les scripts (PVE, dev, serveur app) + unit systemd, rien en dehors.

### Déplacements (état final — feedback utilisateur : « il faut tous les éléments dans deploiement, c'est un livrable »)
| Avant | Après |
|---|---|
| `DEPLOY.md` (racine) | `deploiement/DEPLOY.md` (+ en-tête listant le contenu du dossier) |
| `deploy/proxmox-manager.service` | `deploiement/proxmox-manager.service` (dossier `deploy/` supprimé) |
| `scripts/10-proxmox-token.sh` | `deploiement/10-proxmox-token.sh` (tourne sur le PVE) |
| `scripts/20-package-release.sh` | `deploiement/20-package-release.sh` (outil de dev) |
| `scripts/30-env-setup.sh`, `40-tls-init.sh`, `50-influxdb-init.sh` | `deploiement/…` (installation serveur app) — **dossier `scripts/` supprimé** |

`deploiement/` est désormais **le livrable de déploiement, autonome — déplaçable tel quel** : procédure + les 5 scripts numérotés + unit systemd **+ le tarball de l'application dans `releases/`**.

### Correction « kit déplaçable » (feedback utilisateur : « si je déplace le contenu de ce répertoire, je n'arrive pas à déployer »)
Première version insuffisante : les scripts étaient **ancrés à l'arbre de l'app** (`cd "$(dirname $0)/.."` = « mon parent est la racine ») et l'application n'était pas dans le dossier → déplacer le kit cassait tout. Corrections :
- **Scripts 30/40/50** : 1er argument optionnel `[dossier-install]` (défaut = dossier parent du kit → usage depuis `/opt/proxmox-manager/deploiement/…` inchangé) ;
- **`20-package-release.sh`** : tarball produit **dans `deploiement/releases/`** (exclu du tarball lui-même, pas de récursion) → le kit contient l'application ;
- **Flux cible** : `scp -r deploiement root@cible:/tmp/` → depuis le kit : extraction `releases/*.tar.gz` vers `/opt/proxmox-manager`, puis `./30-env-setup.sh /opt/proxmox-manager proxmox` → `40` → `50` → `up.sh` ;
- DEPLOY.md §3-§5 réécrits autour du « déplacer le kit » ; `.gitignore` : `deploiement/releases/`.

### Vérifications effectuées
- `bash -n` sur tous les scripts ✓ · `10-proxmox-token.sh --dry-run` ✓
- **Simulation cible complète du kit déplacé** (dans /tmp, hors de l'arbre) : copie du kit → extraction du tarball depuis `releases/` → 30/40/50 avec dossier d'installation explicite → `.env`, `data/tls/`, token créés au bon endroit ✓
- Exécution réelle de `20-package-release.sh` : tarball dans `deploiement/releases/`, sans récursion, garde-fou secrets OK ✓
- Grep final : zéro occurrence des anciens chemins dans les fichiers vivants ✓
- Pas de code TS touché

---

## ✅ Fait — Graphes ressources en tête + risque de surallocation dynamique (livré, validé cluster réel)

### Périmètre (arbitrage utilisateur)
« Graphes ressources en tête des dashboards + algorithme de risque de surallocation dynamique » — le ratio statique (alloué/physique) ne suffit pas : analyser l'usage réel.

### Graphes 7 j en rangée 0 (`resource-chart.tsx`)
- **Vue d'ensemble (`/`)** et **dashboard endpoint** : graphes CPU / RAM / disque en tête de la grille (avant les KPIs), `res-cpu/res-ram/res-storage` w4 h3
- **Usage réel** = aire colorée par sévérité (🟢/🟠/🔴 selon `usage` d'`overcommit.json`, défaut 70/90) · **allocation** = ligne pointillée indigo (neutre, hors échelle de sévérité) · bandes seuils 70/90 %
- Données : `/api/metrics?timeframe=week&endpoint=<id|all>` — `endpoint=all` = agrégat tous endpoints (vue d'ensemble) ; `MetricsPoint.storagePct` ajouté (`disk_pct` dans le SQL + l'agrégation)
- **Migration layout** : `LAYOUT_VERSION=2` + merge gate zustand persist → les layouts v1 persistés sont jetés au rechargement, nouveau layout par défaut appliqué

### Algorithme de risque dynamique (`/api/overcommit-risk`, cache 5 min)
- **Demande pire cas** = Σ p95 7 j par VM en marche (InfluxDB `raw.vm_metrics`, SQL `quantile_cont`) vs capacité physique : CPU = Σ cpu_p95 × cœurs / cœurs physiques · RAM = Σ mem_p95 / RAM physique ; stockage = usage réel + jours avant 90 % (capacity planning existant)
- **Niveaux** (configurables dans `overcommit.json` → section `risk`, hot-reload) : 🟢 pire cas <80 % et ratio <2× · 🟠 ≥80–100 % ou ratio 2–3× · 🔴 >100 % ou ≥3×
- Fonction pure `riskSeverity(usagePct, ratio, th)` testée (bornes incluses, seuils custom, `na`) — **6 tests**
- **Cas limites** : VM en marche sans historique → usage courant comme borne basse ; 0 VM en marche → demande nulle (🟢) ; pas de `vm_metrics` pour le cluster (`clusterproxmox`) → `insufficientData=true` + sévérité `na`

### UI
- **Vue d'ensemble** : colonne « Risque » dans la table endpoints (pire sévérité des 3 ressources, 🟢 Faible / 🟠 Modéré / 🔴 Élevé) + `loadRisk` au montage puis toutes les 5 min
- **Endpoint** : 3 graphes en tête + carte surallocation enrichie d'une ligne « pire cas (p95 7 j) : X % » par ressource (teinte = sévérité dynamique) + note « historique < 7 j » si `insufficientData`

### Vérifications effectuées
- `pnpm typecheck` + `pnpm test` (**40 shared** dont 6 nouveaux `riskSeverity` + 24 server) + `pnpm build` : OK
- **Cluster réel** : `/api/overcommit-risk?endpoint=proxmox` → CPU pire cas 1 % (0,2/24 cœurs), RAM 49,8 % (67/135 Go), disque 28 % — p95 par VM identiques aux requêtes InfluxDB directes ; `clusterproxmox` → demande nulle (0 VM en marche)
- `/api/metrics?endpoint=all` = agrégat des 4 nœuds (valeurs distinctes d'un endpoint seul) ; lignes legacy sans tag cluster correctement attribuées via `COALESCE(cluster, 'proxmox')`
- Playwright : 3 graphes en tête des deux pages (lignes d'allocation CPU 132 % / RAM 61 % / disque 34 % en vue d'ensemble), colonne « Risque » = Faible sur les 2 endpoints, lignes « pire cas » de la carte

### Pièges rencontrés (corrigés)
| Piège | Fix |
|---|---|
| **Course au montage** : le fetch `loadRisk`/`loadHeavy` résolvait avant le 1er push WS → la garde `multi?.endpoints.some(...)` jetait les données jusqu'au retry 5 min (systématique pour le risque, cache chaud ~30 ms) | stockage inconditionnel dans le store (données indexées par endpoint id, lues seulement quand l'endpoint est affiché) |
| `@proxmox/shared` consommé via son **dist** (tsup) par server/web | rebuilder shared après toute modif de types avant typecheck server/web |

---

## ✅ Fait — Topologie réseau auto-découverte (livrée, validée mock + cluster réel)

### Périmètre (demandes utilisateur successives)
« Schéma de câblage switches/liens → remonter la configuration réseau via l'API Proxmox » (remplace le schéma de câblage manuel) → puis : topologie **VLAN-aware** + filtre multi-sélection + analyse d'impact incident, **lien VM↔interface** (arêtes cliquables + tableau par interface), **nœuds déplaçables** (drag), et enfin « les petites boîtes net0/net1 doivent être collées à la VM » (libellés d'interface).

### Backend (`packages/server`)
- `proxmox-client.ts` : `getNetwork()` (`GET /nodes/{n}/network`) — NICs physiques = `type: "eth"`, appartenance NIC→pont dans `bridge_ports`, IP dans `cidr`/`address`/`gateway` ; parsing `bridge=` des `net*/mp*` (LXC `type=veth`) dans la config VM
- **Builder pur testé** (`shared/network.ts`, 22 tests) : switches **inférés** (même nom de pont + même sous-réseau = même switch) → nœuds → ponts → segments (pont+VLAN) → VMs ; trafic nœud = RRD netin/netout, trafic VM = agrégat `/cluster/resources`
- Route `/api/network-topology` (cache 5 min) : topologie par endpoint + **analyse d'impact incident** (nœud/pont/NIC tombé → VMs impactées/dégradées) + simulation PRA N-1

### Frontend — React Flow (`components/dashboard/topology-flow.tsx`, page `/topology`)
- **Layout hiérarchique déterministe** (fonction pure) : switches → nœuds → ponts → [segments] → VMs ; couche segment **adaptative** (rendue seulement si des VLANs existent, sinon pont→VM direct)
- Liens animés ∝ débit, pastilles de statut, clic → panneau détail latéral (switch/nœud/pont/segment/VM/interface)
- **Filtre multi-sélection** (VLANs / ponts / NICs) : VMs masquées + éléments supérieurs orphelins estompés
- **Analyse d'impact incident** : sélecteur d'incident → VMs impactées 🔴 / dégradées 🟠 surlignées + détail dans le panneau
- **Simulation PRA N-1** : sélection d'un bâtiment → assombrissement du site tombé + switches orphelins hors service
- **Lien VM↔interface** : arêtes segment/pont→VM cliquables (infos `edge.data` : vmid/iface/bridge/vlan/mac/ip) → panneau « Interface réseau » (pont, VLAN, MAC, IP, impact si cette interface tombe) + surlignage de l'arête ; **tableau par interface** dans le détail VM (`iface | pont | VLAN | MAC | IP` — toutes les interfaces, corrige le MAC limité à `nets[0]`)
- **Nœuds déplaçables** : mode contrôlé canonique (`useNodesState` + `onNodesChange`/`applyNodeChanges`) ; bouton « Réinitialiser le layout » (re-seed du layout déterministe)
- **Libellés d'interface collés à la VM** (arête custom `IfaceEdge`) : `BaseEdge` avec `labelX=targetX`, `labelY=targetY−14` → le libellé (net0, net1…) est rendu juste au-dessus de la boîte VM au lieu du milieu de la courbe ; `data.labelDx` décale horizontalement les libellés d'une VM multi-interfaces (±18 px par interface) pour éviter le chevauchement. Les arêtes switch→pont gardent le bezier par défaut (libellé ports centré)

### Fix allocation disque (graphes ressources)
- `resource-chart.tsx` utilisait `storageTotalBytes` (tout le stockage) au lieu du ratio canonique **thin-only** → désormais `allocPct = computeOvercommit(kpis, config)` (une seule source de vérité ; corrige aussi la ligne RAM) ; `null` si aucun thin (pas de ligne)
- Validé live mock : CPU 33 % / RAM 41 % / disque **6 %** (thin-only 1.38/20 TiB) = exact avec le calcul canonique

### Vérifications effectuées
- `pnpm typecheck` + `pnpm test` (**62 shared** dont 22 network + **24 server**) + `pnpm build` : OK
- **Live mock (HTTP 8093)** : 50 nœuds / 44 arêtes / 100 handles ; clic arête → panneau interface ✓ ; libellés collés aux VMs (gap ~8 px écran, écartement multi-NIC ✓) ; **drag souris CDP réelle** (nœud déplacé de ~917×457 px flow, arêtes + libellés suivent) ✓ ; reset layout ✓ (position d'origine exacte) ; filtre VLAN 20 après drag ✓ (3 VMs visibles) ; dashboard = allocation canonique ✓
- **Cluster réel (HTTPS 8080)** : app saine, `/api/network-topology` OK

### Pièges rencontrés (corrigés — ne pas réintroduire)
| Piège | Fix |
|---|---|
| **React Flow v12 rend 0 arête silencieusement** (aucune erreur console en prod) : nœuds custom sans `<Handle>` DOM → `isNodeInitialized()`/`getEdgePosition()` échouent (`handleBounds` undefined) | composant `FlowHandles` (2 handles invisibles target Top / source Bottom, `opacity:0; pointerEvents:none`) sur les 5 types de nœuds |
| **Drag inopérant en mode contrôlé** : sans `onNodesChange`, React Flow n'applique aucun déplacement (`triggerNodeChanges` ne met à jour le store que si `hasDefaultNodes`) | `useNodesState` + `applyNodeChanges` canonique |
| Arêtes re-mesurées/perdues au re-rendu (filtre/impact) | `renderNodes` préserve l'identité d'objet quand aucune surcharge n'est nécessaire → React Flow garde le nœud interne (dimensions + handles) ; re-seed au changement de topologie conserve `measured` des anciens nœuds |
| Libellés net0/net1 « flottants » au milieu de longues courbes bezier | arête custom `IfaceEdge` : libellé à `(targetX+labelDx, targetY−14)` = collé au-dessus de la VM ; `labelDx` étale les VMs multi-interfaces |
| Tests de drag avec événements synthétiques (`dispatchEvent`) peu fiables avec d3-drag (exige `view: window`) et l'outil MCP `browser_drag` ne déplace pas le nœud du tout | valider le drag avec la **souris CDP réelle** (`page.mouse.move/down/up` + étapes intermédiaires) — fonctionne parfaitement |

---

## ✅ Fait — Inventaire réseaux → VMs + recherche unifiée + hypervision (livré, validé mock multi-endpoints)

### Périmètre (demande utilisateur)
« Une table **au-dessus du graphe** listant **tous les réseaux** et les **VMs qui les utilisent**, un **module de recherche/filtre** sur VLAN / réseau / VM, et des **fonctions d'hypervision** (pack A–F) pour une hypervision **multi-endpoints**. » Puis : **distinction réseau interne Proxmox (gestion) vs externe** (badge « Interne Proxmox »/« Externe ») et **déroulé de sélection de réseau** (le monde réel aura 200 VLAN — la recherche libre ne suffit pas). Conception de référence : `.opencode/skills/network-topology/SKILL.md` (§5). **Zéro changement backend** : `/api/network-topology` renvoie déjà toutes les topologies + débits ; tout est calculé côté client.

### `packages/shared` — logique pure testée (`network-inventory.ts` + `network.ts`)
- `NetworkRow` = un réseau (segment pont+VLAN) : `bridge`, `vlan`, `key` (`segmentKey`), `kind` (`management|external`), `subnets[]`, `nodes[]`, `vms[]` (les `ParsedVmNet` du segment), `trafficIn/Out` (agrégat), `severity` (`ok|warn|crit|na`), `impactedCount`/`degradedCount`.
- `buildNetworkInventory(topo)` (un endpoint) · `buildNetworkInventoryAll(topologies, endpointNames)` (**vue agrégée multi-endpoints**) · `filterNetworkRows<T>(rows, query, multiFilter?)` (générique, conserve les champs agrégés ; `multiFilter.network` = sélection exacte d'un segment).
- `segmentImpact` : impact d'un segment (sémantique identique à `impactAnalysis` : impactée = toutes ifaces coupées, dégradée sinon).
- **Classification interne/externe** : `ipInSubnet(ip, cidr)` (false si malformé) + `managementSegments(topo)` — le réseau interne Proxmox = le segment (pont, VLAN natif) portant l'**IP de gestion** d'un nœud (`TopologyNode.ip`) ; l'API PVE n'a pas de flag → inféré. En pratique = `vmbr0` natif, le reste (VLAN, stockage, autres ponts) = externe.
- **Déroulé (200 VLAN)** : `encodeNetSel`/`decodeNetSel` — encodage URL-safe de la sélection (`vmbr0:n` = natif, `vmbr0:10` = VLAN 10 ; decode → null si malformé).
- Tests vitest (fix : tri `null`-safe `sort((a,b)=>(a??-1)-(b??-1))`).

### `packages/web` — composant + intégration
- **`components/dashboard/network-inventory.tsx`** : table au-dessus de `TopologyFlow`. **Ligne repliée** = réseau + agrégats (**Type** (badge « Interne Proxmox »/« Externe »), sous-réseau, nœuds, nb VMs + running/stopped, trafic, état, impact). **Ligne dépliée** (clic) = sous-tableau des VMs : **`Interface · VM · IP · MAC · Nœud · État`** (interface en 1re colonne — présentation type vCenter, on est dans la zone réseau).
- **Déroulé de sélection de réseau** (`<select>` « Tous les réseaux ») : liste dédoublonnée des réseaux de la vue courante — conçu pour 200 VLAN. Sélectionner un réseau filtre la table, **déplie la ligne** (VMs visibles immédiatement) et **filtre le graphe au segment exact**. Sélection remise à zéro au changement de vue.
- **Recherche unifiée** (pont, VLAN, IP, nom VM, vmid, nœud, sous-réseau) : filtre la **table** (exact) **et le graphe** (filtre dérivé `{bridges, vlans}` depuis les réseaux correspondants, prime sur le MultiSelect tant qu'active). **Filtre graphe** : `TopologyFilter` a une dimension `networks` (segments exacts, déroulé) distincte de `bridges`/`vlans` (OR, approximation de la recherche). Priorité : `netGraphFilter ?? searchGraphFilter ?? filter`.
- **Graphe** : icône bouclier (`Shield`) sur les nœuds pont/segment de gestion + entrée de légende « Réseau interne Proxmox (gestion) ».
- **Fonctions d'hypervision A–F** : **A** vue agrégée « Tous les serveurs » (colonne Serveur, **pas de graphe** — le graphe est par-endpoint ; le sélecteur de vue absorbe l'ancien sélecteur d'endpoint) · **B** état + trafic par réseau · **C** impact en ligne (zéro calcul serveur) · **D** export CSV (**inventaire plat : une ligne par interface VM**, colonne `type` incluse, BOM UTF-8 + échappement) · **E** deep-link `?view=` + `?q=` + `?net=` (`useSearchParams`, écriture en `replace`) · **F** stats running/stopped.
- **i18n** `topo.inv.*` (FR/EN : colonnes, états, recherche, export, vue agrégée, stats, impact, déroulé, **Type**) + `topo.iface.col.vm` + `topo.legend.management` dans `shared/src/i18n/{fr,en}.ts`.

### Vérifications effectuées
- `pnpm typecheck` + `pnpm test` (**88 shared** + **24 server**) + `pnpm build` : OK (**rebuilt `shared` tsup** après modif de types — consommé via `dist`).
- **Playwright (mock multi-endpoints, `MOCK=1 MOCK_SCENARIO=degraded`)** : table au-dessus du graphe ✓ · vue « Tous les serveurs » agrégée (colonne Serveur, pas de graphe) ✓ · vue par-endpoint (table + **graphe React Flow intact** : switches/ponts/segments/VMs/arêtes) ✓ · **recherche** filtre la table (deep-link `?q=nfs` → seule la ligne nfs) ✓ · **ligne dépliée** liste les VMs du segment (Interface avant VM) ✓ · **colonne Type** : `vmbr0 natif` → « Interne Proxmox », VLAN + nfs → « Externe » ✓ · **graphe** : bouclier sur les nœuds de gestion + légende ✓ · **déroulé réseau** : sélection « vmbr0 · VLAN 10 » filtre table + déplie + **filtre le graphe au segment exact** (seules les VMs du VLAN 10 restent) ✓ · deep-link `?net=vmbr0:10` rechargé au montage ✓ · « Tous les réseaux » remet à zéro ✓ · sélecteur incident + simulation PRA + reset layout conservés ✓.

### Pièges rencontrés (corrigés)
| Piège | Fix |
|---|---|
| `@proxmox/shared` consommé via son **dist** (tsup) par web : signature `filterNetworkRows` périmée → TS2339 `endpointName` sur `NetworkRow` | `pnpm --filter @proxmox/shared build` après toute modif de types, avant typecheck/build web |
| `filterNetworkRows` non générique perdait les champs `endpointId`/`endpointName` de la vue agrégée au filtrage | signature générique `<T extends NetworkRow>(rows: T[]): T[]` |

---

## ✅ Fait — Vue stockage type vCenter (livrée, validée mock multi-endpoints + cluster réel)

### Périmètre (demande utilisateur)
« Une vue stockage **type vCenter** : tableau de datastores avec **barre de capacité colorée**, icône de type, nœud/partagé, **drill-down des VMs** sur chaque datastore, **recherche** + **déroulé de type**, vue agrégée, **deep-link**, **export CSV**, seuils de code couleur **modifiables**. » Conception de référence : `.opencode/skills/storage-view/SKILL.md`. **Panneau Ceph + graphes I/O = 2ᵉ temps, hors périmètre.**

### `packages/shared` — logique pure testée (`storage-inventory.ts`, 18 tests)
- `StorageRow` = un datastore : `type`, `kind` (`shared`/`local`), `nodes[]`, `content[]`, `used`/`total`/`pct`/`hasCapacity`, `vms[]` (les `StorageVmRef`), `running`/`stopped`, `diskAllocated`.
- `buildStorageInventory(storages, vms)` (un endpoint) · `buildStorageInventoryAll(endpoints, endpointNames)` (**vue agrégée**, **clés composites** `endpointId/key`) · `filterStorageRows<T>(rows, query, filter?)` (recherche libre + `filter.type` exact) · `sortStorageRows<T>(rows, config, sort)` (**tri des en-têtes** : datastore/server/type/capacity/vms/state, asc/desc, départage par nom) · `storageSeverity({pct, hasCapacity}, config)` — **délègue à `usageSeverity`** (seuils `usage.warn/crit` d'`overcommit.json`, hot-reload) → « na » si pas de capacité. **Aucun seuil en dur.**

### `packages/server`
- **Route `/api/storage-inventory`** (cache 5 min/endpoint) : renvoie par endpoint `{ storages, vms }` (VMs slim : vmid, name, node, status, diskBytes, storage). Le groupement VM→datastore est côté client.
- **`PveStorage.nodes?: string[]`** : `getStorage()` remonte le champ `nodes` de `/storage` (chaîne espace-séparée → tableau).
- **PVE 9 a retiré `storage` de `/cluster/resources`** → le datastore du disque est **dérivé de la config VM** (cache 1 h, déjà fetché pour cpuAlloc/os) : `diskStorageOf(config, type)` (exportée, 10 tests) parse le disque principal (qemu `scsi0`/`virtio0`/…, lxc `rootfs` ; formats `storage:vol` et `pool/vol` ; ISO ignorés). `getResources()` : `if (!v.storage && cached.value.diskStorage) v.storage = cached.value.diskStorage`.

### `packages/web` — composant + page
- **`components/dashboard/storage-inventory.tsx`** : table type vCenter. **Datastore en 1ʳᵉ colonne** (identifiant primaire), Serveur juste après (vue agrégée). **Ligne repliée** : Datastore (icône de type + nom) · Serveur · Type (badge `primary` si shared) · Nœud (badge « Partagé » / nom(s) / `—`) · **Capacité** (**barre colorée** = signature visuelle) · Contenu · VMs (total + running/stopped) · État (🟢/🟠/🔴). **En-têtes triables** (clic ↕/↑/↓) sur Datastore, Serveur, Type, **Capacité** (défaut desc = les plus pleines d'abord), VMs, État — tri **client-side** instantané (pas de virtualisation à 100+ lignes). **Ligne dépliée** = sous-tableau des **VMs sur ce datastore** (`VM · VMID · Disque · Nœud · État`), **paginé à 50 VMs** + « Afficher plus » (garde-fou prod : baie à milliers de VMs).
- **Déroulé de type** (liste dédoublonnée de la vue courante, remise à zéro au changement de vue) · **recherche libre** (datastore/type/nœud/contenu/nom VM/vmid) · **vue agrégée** « Tous les serveurs » ↔ endpoint · **export CSV** (inventaire plat : une ligne par VM sur un datastore, BOM UTF-8) · **deep-link** `?view=` + `?q=` + `?type=` (écrit en `replace`).
- **i18n** `storage.*` (FR/EN : la page). La **carte compacte** de l'endpoint page est repassée dans `storageCard.*` (collision de namespace évitée).

### Vérifications effectuées
- `pnpm typecheck` + `pnpm test` (**113 shared** dont 7 `sortStorageRows` + **34 server** dont 10 `diskStorageOf`) + `pnpm build` : OK (**rebuilt `shared` tsup** après modif de types).
- **Playwright (mock multi-endpoints, `MOCK=1 MOCK_SCENARIO=degraded`)** : page 200 · API 200 (ceph avec `nodes[]`) · tableau affiché · **drill-down** ceph → sous-tableau VMs · **recherche** « db- » → seul ceph · **filtre type** rbd → 1 ligne · **deep-link** `?view=demo-b` → pas de ceph.
- **Cluster réel (HTTPS 8080)** : `/api/storage-inventory` 200, toutes les VMs rattachées à leur datastore (parse config) · **Datastore en 1ʳᵉ colonne** · **tri** capacité (desc = plus pleine en tête, asc = inconnues d'abord) + nom A→Z · **drill-down** paginé validés en navigateur.

### Pièges rencontrés (corrigés — ne pas réintroduire)
| Piège | Fix |
|---|---|
| **404 sur `/api/storage-inventory` en prod** : le serveur tournait sur l'ancien code (tsx = pas de hot-reload) alors que le front (dist buildé) était nouveau | `pnpm build` **puis** `./server.sh restart` — relancer le serveur après toute modif des routes |
| **0 VMs en production** : PVE 9 ne renvoie plus `storage` dans `/cluster/resources` → `if (!r.storage) continue` jetait toutes les VMs | `diskStorageOf` parse le datastore du disque principal de la config VM (cache 1 h) ; jointure `getResources` |
| **Clés React en double en vue agrégée** (datastore homonyme `local`/`local-lvm` sur proxmox ET clusterproxmox) → rendu/filtrage cassés | `buildStorageInventoryAll` produit des **clés composites** `endpointId/key` (test dédié) |
| Collision de namespace i18n `storage.*` entre la page et la carte compacte existante | carte compacte repassée dans `storageCard.*` |
| **Échelle prod (100+ datastores, baies à milliers de VMs)** : rendre toutes les VMs d'une baie au drill-down figerait la page | tri/recherche en **fonctions pures mémoïsées** (pas de virtualisation à 100–500 lignes) + **drill-down paginé à 50 VMs** (« Afficher plus » + compteur) |

---

## ✅ Fait — Architecture plugin du frontend (livrée, validée A/B Playwright)

Refonte **Strangler Fig** : les 3 modules métier du frontend sont des **plugins** chargés par un host, avec feature flags. Ordre de migration : hypervision → network → storage ; chaque module = 2 commits indépendants (ajout du plugin flag OFF → suppression du legacy validé + passage du flag en défaut ON).

### `packages/web/src`
- **Host** : `core/plugin/` (contrat zod `PluginManifest`, registry, loader statique try/catch par plugin, eventBus, logger), `core/config/features.ts` (flags `VITE_USE_PLUGIN_*`), `core/ui/{PluginSlot,PluginMenu,VersionSwitch,ModuleDisabled}`, bootstrap `loadPlugins()` dans `main.tsx` avant le premier rendu
- **Plugins** : `plugins/hypervision/` (routes `/`, `/e/:endpointId`, `/e/:endpointId/n/:nodeId`, menu order 10), `plugins/network/` (`/topology`, order 20), `plugins/storage/` (`/storage`, order 30)
- **Flags = disjoncteurs** : défaut ON (le legacy a été supprimé après validation de chaque module) ; `=false` → écran de repli `ModuleDisabled` propre, pas de route morte
- Le frontend ne parle jamais directement à PVE/InfluxDB : `ctx.api` (client REST partagé) + store WS du host (`core/data`)

### Vérifications effectuées
- À chaque étape : typecheck + build OK + A/B Playwright vs baseline (backend mock 9088, deux instances Vite) — `/`, `/e/:id`, `/e/:id/n/:node`, `/topology`, `/storage` identiques (structure ; seules les valeurs dynamiques du mock varient entre captures)
- Interactions vérifiées : filtrage par endpoint sur topologie + stockage
- Dev plain (`pnpm dev`, aucune variable) = comportement d'origine

### Pièges rencontrés (corrigés — ne pas réintroduire)
- Ordre du menu sidebar : `<PluginMenu />` doit être rendu **avant** les liens legacy pendant la migration (orders 10/20/30 → ordre affiché identique à l'origine dans tous les états de migration)
- `trends-panel.tsx` = code mort (importé nulle part) — supprimé après la migration
- Avant le 1er push WS (~5 s), `multi` est null : les tabs par endpoint affichent l'`endpointId` en attendant le nom (comportement d'origine, identique baseline/plugins)

---

## ✅ Fait — Stockage VM comme série de référence des graphiques « Disque » (`storage_metrics`) (livré, testé — **commité**)

### Problème
La courbe « Disque » utilisait `disk_pct` = **rootfs** du nœud (disque système), qui ne reflète pas l'usage réel du stockage VM.

### Correction (3 couches)
- **Écriture (poller)** : nouvelle mesure InfluxDB `storage_metrics` (tag `cluster` ; champs `used_bytes`, `total_bytes`) = stockage VM au niveau endpoint (KPIs), écrite à chaque tick (5 s). Mode mock exclu.
- **Lecture (routes dashboard)** : `storagePctByTime` — **Σ used / Σ total pondéré par capacité** par bucket (pas une moyenne non pondérée des rootfs) ; `mergeStorageSeries` remplace `storagePct` dans `/api/metrics`.
- **Prévision capacity** : la série disque de `/api/capacity` = `storage_metrics` si disponible, sinon la série legacy rootfs.
- Le consolidateur agrège aussi `storage_metrics` vers la base `consolidated`.

### Sémantique (décision actée)
- Bucket sans série `storage_metrics` → `storagePct: null` (gap ECharts) — **jamais mélangé au rootfs**.
- Repli rootfs legacy **uniquement** si la série est absente au total (historique antérieur au déploiement).
- Vue nœud (`?node=`) exclue de la fusion (le stockage VM est une métrique d'endpoint).

### Vérifications effectuées
- `pnpm exec tsc -b --noEmit` + `pnpm test` (**39/39** dont `routes.test.ts` nouveau) + `pnpm build` : OK
- E2E sur InfluxDB prod : **en attente** (nécessite le pointage `INFLUX_URL` sur l'instance de production)

### Pièges rencontrés (corrigés — ne pas réintroduire)
| Piège | Fix |
|---|---|
| Après pointage InfluxDB prod, la courbe « Disque » s'accumule depuis le 1er tick (7 jours pour une vue complète) — ce n'est pas un bug | Documenté dans les skills `general` §10 et `operations` §7 |

---

## ✅ Fait — Base de connaissance `skills/` (livrée, trackée — **commitée**)

Base de connaissance pour la **reprise du travail** (humain ou IA) : source unique de vérité à la racine du repo (trackée, livrée en production) — **pas** dans `.opencode/` (gitignoré, symlinks locaux uniquement).

| Skill | Périmètre |
|---|---|
| `general` | Architecture globale : contrat plugin, monorepo, flux de données, design system, i18n, overcommit, déploiement, pièges transverses |
| `hypervision` | Plugin hypervision : `/`, `/e/:endpointId`, `/e/:endpointId/n/:nodeId` + composants (KPIs, graphiques 7 j, PRA, capacity, surallocation) |
| `network` | Plugin network : `/topology` — graphe React Flow, inventaire réseaux→VMs, analyse d'impact incident, simulation PRA N-1 |
| `storage` | Plugin storage : `/storage` — table vCenter des datastores, drill-down VMs, export CSV |
| `operations` | Runbook production : kit de déploiement `deploiement/`, pointage InfluxDB externe, systemd/server.sh, day-2, dépannage (WS, repli RRD, TLS SAN, tokens PVE) |
| `shared` | Package `@proxmox/shared` : fonctions pures testées par fichier, types partagés, THRESHOLDS, i18n fr/en |
| `api` | Contrat API REST + WebSocket `/ws` : endpoints, formes de réponse, caches 5 min, repli InfluxDB→RRD |

- Format : frontmatter YAML (`name` + `description` « Use when… ») + sections numérotées (§) — inventaire et règles de maintenance dans `skills/README.md` (skill mise à jour **dans le même commit** que le module).
- `.opencode/skills/*` = symlinks → `../../skills/*` (auto-découverte locale OpenCode, gitignoré).
- Objectif projet documenté dans `skills/README.md` : logiciel modulaire type vCenter pour Proxmox ; les nœuds branchés servent **uniquement à tester l'API et la collecte métriques** ; échelle cible **~500 VMs / ~200 VLANs** (estimation) avec impacts concrets (payload WS, topologie React Flow = point dur).

---

## ✅ Fait — Audit de reprise : README racine aligné (livré — **commité**)

Audit « prêt pour la reprise » du 2026-10-24 : le README racine ne pointait ni vers `skills/` ni vers `STATUS.md`, et deux tableaux étaient périmés. Corrections :
- Nouvelle section **Documentation** en tête (pointeurs `skills/` + `STATUS.md` + `deploiement/DEPLOY.md`)
- Table API complétée : `/api/overcommit-risk`, `/api/network-topology`, `/api/storage-inventory`
- Schéma des mesures : ligne `storage_metrics` ajoutée (+ précisions `disk_pct` = rootfs, `vm_metrics` running uniquement)
- Arborescence : `skills/`, `STATUS.md`, `overcommit.json` ajoutés

Parcours de reprise validé : **README → `skills/README.md` (inventaire) → skill du module concerné → `STATUS.md`**.

---

## ✅ Fait — Renommage du projet : Proxmox Manager → **Prox4u** (livré — **commité**)

Décision utilisateur (2026-10-24) : le projet s'appelle **Prox4u**. Renommé avant tout déploiement public (aucune instance installée, rien de publié → zéro migration).

### Périmètre du renommage
- **Nom d'affichage** « Proxmox Manager » → « Prox4u » : README, STATUS, skills (7 SKILL.md + README), `index.html` (`<title>`), i18n `app.title` (fr/en — sidebar), log de démarrage serveur, en-têtes des scripts, échantillon de design.
- **Identifiants techniques** `proxmox-manager` → `prox4u` : unit systemd renommée `deploiement/prox4u.service`, dossier d'installation `/opt/prox4u`, tarball `prox4u-<date>.tar.gz`, node-id InfluxDB du compose, commandes `systemctl`.
- **Non renommé (volontaire)** : user système `proxmox` (propriétaire des données), scope npm `@proxmox/*`, user/token PVE `manager@pve`, sections historiques de ce fichier (enregistrements datés).

### Vérifications effectuées
- Grep final : plus aucune occurrence « Proxmox Manager » / `proxmox-manager` dans les fichiers trackés hors historique STATUS.md ; artefacts gitignorés purgés par rebuild (`dist/` — `<title>Prox4u</title>` confirmé dans le build web ; `.playwright-mcp/` = snapshots de test datés, ignorés)
- Typecheck + tests + build : OK (152 tests : 113 shared + 39 server, 0 échec)

---

## ✅ Fait — Mise en place locale Prox4u sur 8080 (HTTPS) + arrêt de l'ancienne app (2026-10-24)

Décision utilisateur : **Prox4u prend le port 8080** (l'ancienne app `/home/opencode/projet/proxmox/` est remplacée).

### Bug corrigé dans `server.sh` (**à committer**)
`./server.sh start` mourait **silencieusement** (exit 1, aucun log) : la ligne `TLS_CERT="$(grep -E '^TLS_CERT=' .env | head -1 | cut …)"` — sans `TLS_CERT` dans `.env`, `grep` renvoie 1 → `pipefail` + `set -e` tuent le script avant tout démarrage. Corrigé avec `|| true` (+ commentaire).

### Environnement local (hors repo, gitignoré)
- **`.env`** : ajout `TLS_CERT=data/tls/app-cert.pem` + `TLS_KEY=data/tls/app-key.pem` → l'app sert **HTTPS sur 8080**. Le cert existant couvre déjà les SAN `localhost`, `127.0.0.1`, `192.168.1.180`, `192.168.100.180` (valide jusqu'en 2036) — rien à régénérer.
- **Cron de l'ancienne app désactivé** : les 2 lignes du crontab utilisateur ont été **commentées** (pas supprimées) :
  ```
  #@reboot /home/opencode/projet/proxmox/server.sh start
  #* * * * * /home/opencode/projet/proxmox/server.sh start
  ```
  Backup : `/tmp/opencode/crontab-backup-20261024.txt` (**volatile** — les lignes ci-dessus suffisent pour restaurer). Sans ça, l'ancienne app reprenait le 8080 toutes les minutes.
- **Auto-démarrage Prox4u (même mécanisme que l'ancienne app)** :
  ```
  @reboot /home/opencode/projet/proxmox-plugin-arch/server.sh start
  * * * * * /home/opencode/projet/proxmox-plugin-arch/server.sh start   # watchdog — `start` est idempotent (« déjà en cours » → exit 0)
  ```
  Vérifié : `npx` résolu sous cron (`/usr/bin/npx`), watchdog testé. Le serveur sert aussi le **frontend pré-buildé** (`fastifyStatic` → `packages/web/dist`) : après un changement de code, refaire `pnpm build` pour que le 8080 reflète les modifications (le 5173 Vite reste le flux dev).
- **README** : section « Développement » remplacée par **« Lancement & développement »** (2026-10-25) — mode standard (8080 = API + frontend pré-buildé, `server.sh`, `pnpm build` après changement), mode dev (Vite 5173 + proxy `VITE_API_PROXY`/`VITE_WS_PROXY`), tableau auto-start (systemd prod / cron watchdog dev), commandes utilitaires. Quickstart corrigé (`cd Prox4u`).
- **État de marche** : backend Prox4u sur `https://localhost:8080` (`./server.sh start`, mode réel → PVE 192.168.1.80 + clusterproxmox), Vite dev sur `http://0.0.0.0:5173` avec proxy `VITE_API_PROXY=https://localhost:8080` / `VITE_WS_PROXY=wss://localhost:8080`. Mock 9088 inutile (`clusters.json` pointe sur les PVE réels).

## ✅ Fait — Module « Inventaire des VM » (style vCenter) (livré, validé cluster réel + Playwright — **commité**)

Décisions utilisateur (2026-10-25) : v1 = **inventaire en consultation pure** (pas d'actions power — les tokens PVE actuels sont lecture seule `ManagerReader`) + **vue détail complète** à onglets.

### Données
- `VmSummary` (snapshot WS, push 5 s) enrichi : `diskBytes`, `maxdiskBytes`, `cpuAllocCores`, `os`, `uptimeSec` — données déjà en mémoire du poller (`cluster/resources` + jointure config), **zéro nouvel appel API** pour la liste.
- Nouvel endpoint REST **`GET /api/vm-config?endpoint=&vmid=`** (module `modules/vminventory/routes.ts`) : état live (snapshot courant) + config (`getVmConfig`, cache 1 h) + snapshots (**nouvel appel PVE** `/nodes/{n}/{type}/{vmid}/snapshot`, à la demande, cache 5 min ; pseudo-entrée PVE `current` filtrée).
- `DataSource.getVmSnapshots()` ajouté à l'interface + `ProxmoxClient` (réel) + `MockSource` (déterministe : vmid%4==0 → 2 snapshots, vmid%4==2 → 1).
- `VmConfigInfo` déplacé du serveur (`data-source.ts`) vers `@proxmox/shared/types.ts` (règle : types jamais dupliqués server/web) + nouveau type `VmDetailResponse`.

### Fonctions pures + tests (`shared/vm-inventory.ts`, 13 tests)
- `filterVmRows` (recherche nom ou vmid exact, filtres nœud/statut/type), `sortVmRows` (8 clés ; diskBytes manquant toujours en fin de liste quel que soit le sens), `buildVmTree` (Datacenter → endpoints → nœuds, compteurs en marche/total).

### Plugin web `vm-inventory` (pattern du plugin storage)
- Route `/vms`, menu « Inventaire VM » (order 40), flag `VITE_USE_PLUGIN_VM_INVENTORY` (défaut ON).
- Layout vCenter : **tree** à gauche (Datacenter → cluster → nœud, clic = périmètre + expansion), **tableau** au centre (Nom, ID, Nœud, Type VM/LXC, Statut, CPU %, Mémoire utilisé/max, Disque utilisé/max ; filtres statut/type + recherche ; colonnes triables ; stats « X en marche · Y arrêtées »), **panneau détail** à droite au clic sur une ligne (onglets Configuration / Réseau / Snapshots, barres d'utilisation colorées).
- État (sélection tree, recherche, filtres, VM détaillée) synchronisé dans l'URL → deep-link.
- i18n fr/en : `nav.vmInventory` + ~50 clés `vm.*`.

### Validation
- typecheck OK (3 packages), **163 tests** (124 shared + 39 server), build OK, backend redémarré.
- Smoke API cluster réel : `/api/vm-config?vmid=100` → live + config (2 NICs net0→vmbr0 / net1→nfs, datastore « rapide ») + snapshots [].
- Playwright (Chromium headless) : 7 lignes au tableau, panneau détail ouvert au clic, **zéro erreur console** (captures `/tmp/opencode/vm-inventory.png` + `vm-detail.png`).
- Limite côté données connue : `diskBytes=0` sur certaines VMs (PVE 9 renvoie 0 dans `/cluster/resources` selon le stockage) — l'UI affiche « 0 o / X To », pas de crash.

### Roadmap (hors périmètre de cette itération)
- Actions power (start/stop/reboot) : token PVE **écriture** + endpoints POST + UI de confirmation → itération dédiée.

---

## ✅ Fait — Authentification multi-utilisateurs (port complet de l'ancienne app) (livrée, validée E2E — **commitée**)

Décision utilisateur : **restaurer l'authentification** en portant l'implémentation de l'ancienne app (`/home/opencode/projet/proxmox/`, lecture seule). Comptes migrés tels quels (hashes argon2id compatibles, verify OK).

### Dépendances (exception validée)
- **`argon2` ^0.45.1** + **`@fastify/cookie` ^11.1.3** — installées **hors-ligne** (pas de réseau dans l'environnement) : copie des packages depuis le `.pnpm` de l'ancienne app + insertion manuelle dans `pnpm-lock.yaml` (packages + snapshots + importers) + `pnpm install --offline --trust-lockfile`. `allowBuilds: { argon2, esbuild }` dans `pnpm-workspace.yaml`. Prébuild linux-x64 d'argon2 OK sous Node 24.

### Server (`modules/auth/`)
- **Store** (`store.ts`) : `data/auth.json` (gitignoré, chmod 600, écriture atomique tmp→rename) — users/groups/modules/userGroups/userModules/groupModules. Seed 1er démarrage : `admin`/`proX4u` (changement forcé) + catalogue `DEFAULT_MODULES`. **Réconciliation** du catalogue au chargement, **au niveau famille** (les entrées de version `<famille>_vN` d'une famille connue sont conservées, leurs préférences aussi). `setUserModules` accepte les ids de version (`<famille>_vN`) — validation par famille via `parsePluginVersion`. `syncModuleCatalog(ids)` : crée les entrées de catalogue manquantes (état hérité de la famille), idempotent.
- **Routes** : `POST /api/auth/login` (throttle 5 échecs/15 min → 429), `GET /api/auth/me`, `POST /api/auth/logout`, `PUT /api/auth/preferences` (moduleIds = familles ou versions `_vN`), `PUT /api/auth/password`, **`PUT /api/auth/catalog-sync`** (session : le web envoie les ids de tous ses plugins enregistrés → le serveur crée les entrées manquantes, `{ok, created}`) ; admin : `GET /api/admin/state`, CRUD users/groups, `PATCH /api/admin/modules/:id` (**globallyEnabled par entrée = par version**, id exact).
- **Guard** : publics = `/api/auth/login` + `/api/health` ; tout le reste `/api/*` exige une session cookie httpOnly `pvm_session` (TTL 12 h, `AUTH_SESSION_TTL_HOURS`) ; `/api/admin/*` rôle admin. **WS protégé** (`verifyClient` sur le cookie session).

### Web
- `lib/auth-api.ts` (authApi + adminApi), `store/auth.ts` (zustand : user, authorizedModules, visibleModuleIds, **visibleVersionIds**), `core/plugin/catalog-sync.ts` (sync web→serveur au boot et après login), `components/auth/*` (login-form, protected-route = `ProtectedRoute` + `ModuleRoute`, change-password-form, module-selector = une case par version), pages `/login` + `/profile` (onglets Profil / Mot de passe / Modules).
- **Page admin** (`/admin`, 3 onglets) : **Catalogue des modules**, Groupes, Utilisateurs.
- Visibilité **par version** : le catalogue serveur tient une entrée par version (v1 = id de famille, vN = `<famille>_vN`), chacune avec SON `globallyEnabled`. Une version est **autorisée** si activée globalement OU si sa famille est attribuée à un groupe ; **visible** = autorisée ∩ sélectionnée par son id EXACT dans les préférences. `authorizedModules` (`/me`) = les entrées autorisées au niveau VERSION (`authorizedModuleEntries`, shared) — ce sont les lignes de « Mon profil → Modules » : une ligne ne sert que si la version peut être visible (v1 OFF + v2 ON → seule la ligne v2 s'affiche). La rubrique Modules **ré-hydrate `/me` à chaque ouverture** (`ModuleSelector` → `refresh()` au mount) : un module activé/désactivé dans le catalogue admin y est visible immédiatement, sans action préalable sur un module existant, quel que soit le navigateur. `/me` renvoie aussi `visibleVersionIds` (ids exacts — filtre menu + versions rendues sur les routes partagées) et `visibleModuleIds` (familles dérivées — ModuleRoute + liste d'endpoints du sidebar). Après un toggle admin, le store re-hydrate `/me` (sidebar à jour immédiatement).
- Topbar : `UserActions` (profil, logout).

### Validation
- typecheck 3 packages OK · **208 tests** (152 shared + 56 server, dont argon2 hash/verify + store auth) · build OK
- E2E HTTP (user temporaire) : login 200, `/me` 200, `/api/dashboard` 200, `/api/admin/state` 403 (rôle user), 401 sans session ✓

---

## ✅ Fait — Versionnement des modules `_vN` + `vm-inventory_v2` « Console web » (livrés, validés E2E navigateur — **commités**)

Convention utilisateur : **toute modification d'un module existant crée un nouveau plugin `<id>_vN+1`** — jamais de modification en place ; la v1 reste intacte = rollback. **Toutes les versions sont disponibles sans activation admin** (décision 2026-10-25) : la plus récente est canonique par défaut sur l'URL partagée.

### `packages/shared` (`module-versions.ts`, fonctions pures testées)
- `PLUGIN_ID_RE`, `parsePluginVersion` (famille + numéro), `defaultPluginVersion` (la plus récente = version canonique, remplace `activeVersionFor`), `groupPluginFamilies` ; `DEFAULT_MODULES` dans `auth.ts`.

### Host web
- `registry.ts` : statuts `registered | active | available | failed` — `active` = version canonique de la famille (la plus récente), `available` = autres versions (A/B + rollback) ; `initialized()` alimente routes et menu.
- `loader.ts` : groupement par famille ; **toutes les versions sont initialisées** (manifeste validé pour toutes) — la plus récente → statut `active` (canonique), autres → `available`.
- `main.tsx` : `loadPlugins(PLUGINS, createPluginContext())` avant le premier rendu (registry statique ensuite).
- `app.tsx` : routes protégées, `ModuleRoute` par famille ; sur une route multi-versions, **seules les versions sélectionnées dans le profil sont rendues** (défaut = canonique si sélectionnée, sinon première sélectionnée ; `?v=` non sélectionné → repli sur le défaut).

### Plugin `vm-inventory_v2` (v0.2.0)
- Copie de la v1 + **bouton « Console web (UI PVE) »** dans l'en-tête du détail VM → `${endpoint.url}/#next;nodes/<node>/<type>/<vmid>/console` (nouvel onglet, `noopener,noreferrer`) ; désactivé sans URL endpoint (mode démo). Référence visuelle : captures vSphere.
- i18n `vm.console.web` / `vm.console.unavailable`.

### UI admin — catalogue par version (2026-10-25)
- **Catalogue des modules** : une **carte par entrée du serveur** (chaque version = une carte dissociée, badge `vN` seulement en famille multi-versions + semver du manifeste). **Aucun tag « Active », aucun bouton « Activer »** — toutes les versions sont disponibles, la plus récente est canonique par défaut. Le toggle « pour tout le monde » est **par version** (état indépendant — voir entrée ci-dessous).

### Mode A/B — les versions dans le menu de gauche (2026-10-25)
Demande utilisateur : voir **les deux « Inventaire VM » dans la sidebar** avec leur indicateur de version, pour comparer directement.
- **Host** : `registry` — statut `available` (version initialisée mais non canonique) + méthode `initialized()` ; `loader` initialise **toutes** les versions (dépendances satisfaites par n'importe quelle version initialisée de la famille) ; `disposePlugins` dispose toutes les versions initialisées.
- **Routes** : `core/ui/VersionSwitch.tsx` — quand plusieurs versions partagent un chemin, la route rend la version demandée via `?v=<id de plugin>` (défaut = version canonique, la plus récente). L'URL canonique de la famille ne change pas (`/vms`).
- **Menu** (`PluginMenu.tsx`) : une entrée par version **visible pour l'utilisateur** (autorisée ∩ sélectionnée dans le profil — `visibleVersionIds`), badge `vN` sur chaque ligne (v1 neutre, vN+ accentué, même style que le catalogue admin) ; la version canonique porte le lien canonique, les autres `?v=<id>` ; détection « active » sur pathname + search (NavLink ne compare que le pathname).
- La **version canonique** (la plus récente) est la référence : lien canonique, défaut du VersionSwitch, cible des deep-links. Toutes les versions restent navigables — aucune activation admin.

### Validation E2E navigateur (Playwright, cluster réel)
- Catalogue : entrée `vm-inventory_v2` visible avec badge v2 + bouton « Activer » ✓ · activation depuis le catalogue → badge « Active » sur la v2, v1 en rollback ✓ · `/vms` servi par la v2 : tableau live + **bouton « Console web (UI PVE) » présent et activé** ✓ (captures `/tmp/opencode/e2e-catalog-*.png`, `e2e-console-v2.png`)
- Menu A/B (v2 active en prod) : sidebar = deux entrées « Inventaire VM » badgées v1/v2 pointant vers des URLs différentes (`/vms?v=vm-inventory` vs `/vms`) ✓ · v1 : détail VM **sans** bouton console ✓ · v2 : bouton « Console web (UI PVE) » présent et activé ✓ (captures `/tmp/opencode/e2e-menu-ab-*.png`)
- Piège E2E retenu : un user sans préférences est redirigé vers `/profile` par les ModuleRoutes → sélectionner d'abord ses modules (`PUT /api/auth/preferences`).

### Retrait du mécanisme « version active » + sélection par version respectée partout (2026-10-25)
Demande utilisateur : **pas de tag « Active », pas de bouton « Activer »** — toutes les versions d'un module sont disponibles par défaut.
- **Suppression complète** : champ `activeVersions` (AuthFile, AuthPayload `/me`, store serveur, `/api/admin/state`), route `PUT /api/admin/modules/:family/active`, broadcast WS `modules-changed` (+ listener SPA), `fetchActiveVersions()` (`main.tsx`), reload conditionnel (`app.tsx`), badge « Active » + bouton « Activer » (catalogue), clés i18n `admin.versions.*` + `admin.tab.versions`.
- **Règle canonique calculée** : `defaultPluginVersion(famille, ids)` = la version la plus récente enregistrée (fonction pure testée, remplace `activeVersionFor`) — rien à persister, rien à configurer.
- **Bug corrigé** : `AuthStore.setUserModules` rejetait silencieusement les ids de version (`vm-inventory_v2`) des préférences utilisateur (validation par id exact de famille) → validation par FAMILLE via `parsePluginVersion` (test serveur dédié). C'est ce qui empêchait de sélectionner la v2 dans Mon profil.
- **Routes respectent la sélection du profil** (`app.tsx`) : sur une route multi-versions, seules les versions cochées sont rendues ; défaut = canonique si cochée, sinon première cochée ; `?v=` vers une version non cochée → repli sur le défaut. (Sélecteur zustand avec référence stable `EMPTY_MODULE_IDS` — un `?? []` dans le sélecteur faisait boucler `useSyncExternalStore`, React #185.)
- **E2E Playwright 24/24 + 13/13** (compte temporaire, `vm-inventory` activé globalement le temps des tests) : catalogue = 5 cartes dissociées, espace v1→v2 = 12 px identique aux autres cartes (non collées), aucun tag Active / bouton Activer ; **sélection V1 seule** → menu 1 entrée badgée v1 + `/vms` sert la v1 (+ repli `?v=…_v2` → v1) ; **sélection V2 seule** → menu 1 entrée badgée v2 + `/vms` sert la v2 (+ repli `?v=vm-inventory` → v2) (captures `/tmp/opencode/e2e-catalog-*.png`, `e2e-select-*.png`).
- **État prod restauré après E2E** : compte temporaire supprimé, `vm-inventory.globallyEnabled=false` (choix utilisateur), champ `activeVersions` retiré de `data/auth.json`.

### Toggles « pour tout le monde » indépendants par version (2026-10-25)
Bug signalé : cliquer sur `vm-inventory` dans le catalogue basculait aussi `vm-inventory_v2` et réciproque — l'état `globallyEnabled` était partagé au niveau famille.
- **Modèle de données** : `modules[]` tient désormais **une entrée par version** (v1 = id de famille, vN = `<famille>_vN`), chacune avec SON `globallyEnabled`. Les entrées de version sont créées par **sync web→serveur** (`PUT /api/auth/catalog-sync`, le serveur ne connaît pas les versions — seul le registry web le sait) : héritage nom/description/état de la famille, idempotent. Appelée au boot (App) et après login (store) ; `created > 0` → re-hydrate `/me`.
- **shared** (`auth.ts`, fonctions pures testées) : `computeVisibleVersionIds` (entrée autorisée ∩ sélection par id EXACT ; repli sur l'état de la famille pour une version sélectionnée sans entrée, état pré-sync), `computeVisibleModuleIds` dérivé des versions visibles, `authorizedModuleIds` normalise en famille (une entrée v2 globale autorise la famille).
- **Server** : `syncModuleCatalog` + réconciliation **famille-aware** (avant, elle supprimait au redémarrage les entrées de version ET les préférences `_vN` — bug latent introduit par l'acceptation des ids de version) ; `/me` enrichi de `visibleVersionIds` ; `authorizedModules` filtré par famille.
- **Web** : catalogue = une carte par entrée serveur, toggle indépendant (PATCH id exact) + re-hydrate `/me` après bascule (sidebar à jour immédiatement) ; menu et routes pilotés par `visibleVersionIds` (plus de sélecteur `selectedModuleIds` ad hoc) ; module-selector : lignes = entrées autorisées servies par `/me` ; GroupManager dédupliqué en familles (les groupes autorisent des familles entières).
- **E2E Playwright 24/24** (`/tmp/opencode/e2e-toggle-independent.cjs`, déterministe : état initial imposé via API, vérité = état serveur pollé, reload complet avant assertions de menu) : v1 OFF → carte v2 inchangée ON, menu = v2 seule, `/vms` sert la v2 ; v2 OFF → v1 inchangée, menu vide, `/vms` → `/profile` ; v1 ON → v2 inchangée OFF, menu = v1 seule, `/vms` sert la v1 (captures `e2e-toggle-*.png`).
- **État prod restauré après E2E** : compte temporaire supprimé, `vm-inventory` + `vm-inventory_v2` activés pour tout le monde (choix utilisateur), 208→**219 tests** (159 shared + 60 server).

### Rubrique « Mon profil → Modules » toujours à jour + lignes par version réelle (2026-10-26)
Bug signalé : après ajout/suppression d'un module dans le catalogue, la rubrique Modules du profil ne le montrait que **après une action sur un module existant** — seul le `setPreferences` (cocher une case) ré-hydratait le catalogue côté client.
- **Refresh à l'ouverture** : `ModuleSelector` appelle `refresh()` (`GET /me`) au mount — la rubrique est toujours à jour quand on l'ouvre, dans n'importe quel navigateur (store zustand par onglet, aucune synchro inter-onglets).
- **Bug plus profond révélé par l'E2E** : `authorizedModules` (`/me`) était filtré par FAMILLE — avec v1 OFF et v2 ON, la ligne v1 s'affichait quand même (cocher ne servait à rien : la version n'est jamais visible). Nouvelle fonction pure `authorizedModuleEntries` (shared, testée) : les entrées autorisées au niveau VERSION (activée globalement OU famille par groupe) alimentent `/me` ; `computeVisibleVersionIds` la réutilise.
- **E2E Playwright 12/12** (`/tmp/opencode/e2e-profile-modules-refresh.cjs`, deux sessions simultanées du même compte, clics de catalogue vérifiés sur l'état serveur) : v1 OFF → la ligne v1 disparaît de la rubrique **sans aucune action**, y compris dans la seconde session (remontage de la rubrique sans reload) ; v1 réactivée → les lignes reviennent, case v1 toujours cochée (sélection conservée) (capture `e2e-profile-modules-refresh.png`).
- **Piège E2E retenu** : un clic Playwright sur un toggle peut être avalé par un re-render → cliquer « à l'aveugle » une seule fois donne de faux négatifs ; vérifier l'état serveur et re-cliquer tant que l'effet n'est pas là.
- **État prod restauré** : compte temporaire supprimé, v1 + v2 activés pour tout le monde, **222 tests** (162 shared + 60 server).

---

## ✅ Fait — `vm-inventory_v2` approche vCenter : VMs dans l'arbre + détail plein écran (livré, validé tests/build — **commité**)

Demande utilisateur (2026-10-26) : « v2, je souhaite une approche vcenter » + capture vSphere Client en référence → les VMs sont des **feuilles cliquables de l'arborescence** et leur détail **remplace le tableau** (plein écran), avec onglets + grille de panneaux Résumé (style vSphere).

### shared (`vm-inventory.ts`)
- `VmTreeNode` : nouveau kind `'vm'` + champs `vmid`, `type`, `status` (feuilles uniquement) ; id d'une feuille = `<endpointId>/<node>/<vmid>`.
- `buildVmTree(…, opts)` : nouvelle option `includeVms` (**défaut false** → comportement v1 inchangé). Si activée : feuilles VM sous chaque nœud, triées par nom puis vmid ; compteurs nœud/endpoint/datacenter inchangés.
- Tests : 13 → **15** (ids/tri/compteurs des feuilles + défaut sans `includeVms` = pas de feuilles).

### Plugin `vm-inventory_v2` (v0.2.0)
- **Tree** (`vm-tree.tsx`) : feuilles VM avec icône (QEMU `MonitorSmartphone` / LXC `Container`) + pastille d'état (🟢 running / 🟠 paused / gris arrêtée) ; conteneur scrollable (`max-h-[calc(100vh-240px)]` — parcs à centaines de VMs).
- **Page** (`vm-inventory.tsx`) : `buildVmTree({ includeVms: true })` ; clic feuille → `?vm=<vmid>` (+ rescoping de l'arbre sur son nœud) ; clic nœud → retour au tableau (efface `?vm`). VM sélectionnée → le détail **remplace le tableau** (plein écran), l'arbre reste à gauche. Deep-link inchangé (`?tree=&q=&status=&type=&vm=`).
- **Détail** (`vm-detail.tsx`) réécrit en page plein écran : en-tête (retour ←, icône, nom + `#vmid · endpoint/nœud`, badge statut, bouton « Console web (UI PVE) ») + onglets **Résumé** / Configuration / Réseau / Snapshots. Résumé = grille de 6 panneaux style vSphere : OS invité · Détails de la machine virtuelle (état d'alimentation, géré par, nom DNS, adresses IP, chiffrement) · Matériel VM (CPU, mémoire, disque 1 + datastore, adaptateur 1 + pont, compatibilité) · Utilisation (dernière mise à jour + barres CPU/mémoire/stockage) · Objets liés (cluster → `/e/:id`, hôte → `/e/:id/n/:node` cliquables, réseaux, stockage) · Détails VM (pool, classe, ID, uptime).
- i18n fr/en : `vm.tab.summary`, `vm.back` + ~29 clés `vm.sum.*`.
- **v1 : zéro changement de comportement** (seul un garde-fou TS pour le kind `'vm'` — branche inatteinte, la v1 ne passe jamais `includeVms`).

### Validation
- typecheck 3 packages OK · **224 tests** (164 shared + 60 server) · build web OK.
- Bundle servi par le serveur en cours **sans restart** (statiques lus depuis disque) ; nouvelles chaînes présentes dans le bundle servi (`vm.sum.guestOs`, « Détails de la machine virtuelle »).
- Validation visuelle : à faire par l'utilisateur sur `/vms` (mdp admin changé sur cette instance — pas de compte Playwright).

---

## ✅ Fait — Onglet Monitor VM (InfluxDB) + export CSV des graphiques (livré, validé tests/build/typecheck — **commité**)

Demande utilisateur (2026-10-26) : « il manque monitoring pour les VM. on utilise les informations d'influxdb. il faut prévoir un export des data sur les graphiques de monitor. » puis « la vue d'ensemble a la connexion à influxdb. il faut dans monitor: CPU, RAM, Disques, réseaux » → onglet **Monitor** dans le détail VM (v2), positionné comme vSphere (Résumé | **Monitor** | Configuration | Réseau | Snapshots), 4 graphes + bouton **Exporter CSV**.

### Données (extension du schéma `vm_metrics` — écriture poller étendue)
- `raw.vm_metrics` (push 5 s, rétention 31 j) : tags `cluster/node/vmid/name`, champs `cpu_pct` (% du CPU alloué), `mem_bytes` + **nouveaux** `disk_read_bps` / `disk_write_bps` (octets/s) et `net_in_bps` / `net_out_bps` (**bits/s — unité PVE**, même convention que `node_metrics`) — écrits par le poller pour chaque VM **running** (valeurs déjà parsées dans `PveVmResource`, zéro nouvel appel API). `consolidated.vm_metrics` : mêmes champs agrégés en AVG 5 min.
- Les points antérieurs à l'extension n'ont pas les champs I/O/réseau → `null` dans la réponse (le graphe démarre plus tard, pas à 0).
- `VmSummary` enrichi des 4 débits live (`netInBps/netOutBps/diskReadBps/diskWriteBps`) — dispo aussi via WS.

### Serveur (`modules/vminventory/routes.ts` + poller + consolidator)
- **`GET /api/vm-metrics?endpoint=&vmid=&timeframe=`** : `date_bin` + AVG des 6 champs en SQL (même pattern que `TF_SQL` du dashboard) — `hour` → raw/1 min (~60 pts), `day` → raw/5 min, `week` → raw/1 h, `month` → **consolidated**/1 j (< 300 pts). Filtre `COALESCE(cluster, défaut) = endpoint` (lignes legacy) + `vmid`.
- Réponse `{ timeframe, vmid, points: [{ time, cpuPct, memBytes, diskReadBps, diskWriteBps, netInBps, netOutBps }], source: 'influx' | 'insufficientData' }` — **pas de repli RRD** (les RRD PVE sont au niveau nœud, pas VM) ; série vide ou InfluxDB indisponible → `insufficientData`. Cache 5 min par `(endpoint, vmid, timeframe)`.
- Poller : écriture `vm_metrics` étendue des 4 débits ; consolidator : AVG des 4 nouveaux champs dans la fenêtre 5 min.
- Fonctions pures exportées + testées : `VM_METRICS_TF` (mapping timeframes) + `vmMetricsRowsToPoints` (lignes SQL → points triés, nulls par champ conservés — dont les champs I/O absents des données pré-extension —, buckets sans horodatage écartés, entrée non mutée).

### Web (`vm-inventory_v2`)
- **`components/vm-monitor.tsx`** (nouveau) : timeframes **1 h / 24 h / 7 j / 30 j** (clés `metrics.tf.*` réutilisées), **4 graphes ECharts empilés un par ligne** (pleine largeur, ~260 px de haut — demande utilisateur « plus de profondeur », mêmes briques que `resource-chart`/`metrics-panel` : `useEChart` + `chartTheme`) — **CPU** (aire 0–100 % du CPU alloué, bandes de seuils overcommit.json 🟢🟠🔴), **Mémoire** (aire en octets + ligne pointillée indigo = RAM allouée si connue), **Disques** (2 séries lecture/écriture, couleurs `ct.diskRead`/`ct.diskWrite` ajoutées au thème), **Réseau** (2 séries RX/TX, `ct.netIn`/`ct.netOut`). **Auto-refresh 60 s** pendant que l'onglet est ouvert ; chargement **lazy** (composant monté uniquement à l'ouverture de l'onglet) ; état vide propre si `insufficientData`.
- **Export CSV** (demande : « mettre l'exportation sur le graphe et garder général ») : **par graphe** — petit bouton ⬇ dans l'en-tête de chaque carte, exporte les colonnes du graphe (`cpu` / `mem` / `disk` = lecture+écriture / `net` = rx+tx) ; **+ export général** dans la barre d'outils (toutes les colonnes, scope `all`). Timeframe affiché uniquement (« on exporte ce qu'on voit »), inventaire plat BOM UTF-8 + échappement (pattern des inventaires réseaux/stockage) : `timestamp ISO 8601` + colonnes ; fichier `vm-metrics-<nomVM>-<scope>-<timeframe>-<date>.csv`.
- `apiClient.fetchVmMetrics()` + re-export type `VmMetricsResponse` (`core/api/types.ts`) ; `formatBps` ajouté à `lib/utils.ts` (affichage decimal, même convention que le dashboard).
- i18n fr/en : `vm.tab.monitor` + 8 clés `vm.mon.*`.

### Validation
- typecheck 3 packages OK · **230 tests** (164 shared + 66 server, dont 6 `vm-metrics`) · build web OK.
- Serveur **relancé** (`./server.sh restart` — le code serveur a changé, contrairement aux statiques web) ; route `/api/vm-metrics` enregistrée (401 sans session comme les routes protégées).
- Écriture InfluxDB vérifiée de bout en bout : `SELECT … FROM vm_metrics` → les 6 champs présents avec valeurs réelles (VMs 100/102/103).
- Validation visuelle : à faire par l'utilisateur sur `/vms` → clic VM → onglet Monitor.

### ⚠️ Incident InfluxDB rencontré pendant la livraison (corrigé — à retenir)
Pendant les tests, le conteneur `proxmox-influxdb` était en **boucle de crash** (633 restarts depuis le boot du host à 10:15) : à chaque démarrage, le WAL replay sautait des fichiers corrompus puis le premier flush **collait** sur un fichier existant → `invoking shutdown: a WAL file this process was writing already exists` → exit 0 → restart. Cause racine : l'extinction non propre du **15 oct 20:17** (dernière écriture persistée) avait laissé 11 fichiers WAL vides/zero-filled (`00000066135-66145.wal`) ; la machine étant restée éteinte jusqu'au 26 oct, le conteneur n'a jamais pu démarrer proprement depuis le boot. **Correction** : conteneur arrêté → suppression des 11 fichiers (sauvegardés dans `/tmp/opencode/influx-wal-backup/`, données = quelques secondes du 15 oct) via un conteneur one-shot root (les fichiers sont owned uid 1500, pas de sudo) → redémarrage → healthy, flushes 5 s revenus. **Leçon** : si InfluxDB 3 Core crash-loop après un arrêt brutal du host, vérifier `docker logs` (mot-clé « already exists on the object store ») et nettoyer les WAL `< 12 octets` ou zero-filled dans `data/influxdb/proxmox-manager/wal/`. Conséquence collatérale : depuis le boot du matin, les métriques du dashboard tournaient en **repli RRD** (`source: rrd`) — l'app ne crashait pas, les graphes étaient juste moins précis.

---

## ✅ Fait — Nœuds Proxmox dans l'inventaire v2 « comme des VMs » (livré, validé tests/build/typecheck — **commité**)

Demande utilisateur (2026-10-26) : « oui de plus dans inventaireV2, il manque les noeuds proxmox. Il faut ajouter les noeuds proxmox, comme des VM. » → un nœud PVE est **sélectionnable dans l'arborescence comme une VM** et sa page détail plein écran (onglets Résumé / Monitor / VMs) remplace le tableau. **Zéro changement serveur** : tout existait déjà (`NodeHealth` dans le snapshot WS, `GET /api/metrics?node=` + `fetchMetrics(tf, epId, node)` pour l'historique InfluxDB, `VmTable` v2, clés i18n `node.*`).

### ⚠️ Correction — les PSI ne sont PAS exposés par l'API PVE 9.1.1 **au niveau nœud**
Vérifié **sur le cluster réel** (token de l'app) : `/nodes/{n}/status` et `/cluster/resources?type=node` ne contiennent aucun champ `psisome`/`psifull`, aucun endpoint dédié (501). L'affirmation antérieure « PVE expose les PSI par nœud » était fausse pour cette version. Pour obtenir les PSI **nœud** il faudrait lire `/proc/pressure/*` **sur chaque nœud** (SSH ou agent local) — hors périmètre d'une supervision par API ; conservé en roadmap avec cette contrainte documentée.
**Nuance découverte le 2026-10-26** : les PSI **par VM** SONT exposées et documentées dans `/nodes/{n}/qemu/{vmid}/status/current` (champs `pressurecpusome/full`, `pressureiosome/full`, `pressurememorysome/full` — « pressure stall average over the last 10 seconds », valeurs réelles vérifiées sur le cluster). Exploitable sans SSH si besoin (roadmap : KPI santé VM).

### Web (`vm-inventory_v2`, web uniquement — pas de restart serveur)
- **Page** (`vm-inventory.tsx`) : nouveau paramètre deep-link `?node=<endpointId>/<nomNœud>` (à côté de `?vm=`). Modèle de navigation : clic nœud → `?tree=ep/node` + `?node=…` (ferme `?vm`) · clic VM → garde `?node` si la VM vient de ce nœud, sinon l'efface · clic endpoint/DC → efface `?vm` et `?node` · bouton retour du détail VM → revient au détail nœud si `?node` est présent, sinon au tableau. Le composant `VmTree` est **inchangé** (le clic faisait déjà select + expansion) — seule la logique de page a changé : le clic nœud ouvre désormais le détail (le filtrage du tableau par nœud reste accessible via l'onglet VMs du détail).
- **Détail** (`components/node-detail.tsx`, nouveau) : même coque que `vm-detail.tsx` — en-tête (retour ←, icône `Server`, nom, `endpoint/nœud`, badge online/offline + sévérité, ratios de surallocation ×CPU/×RAM, IP · PVE x.y · uptime) + 3 onglets :
  - **Résumé** : 4 cartes KPI (CPU % + cœurs utilisés/total, RAM utilisée/total, Disque rootfs %, Charge moyenne 1/5/15 min) — snapshot WS live, zéro API ;
  - **Monitor** : montage lazy de `NodeMonitor` ;
  - **VMs** : `VmTable` v2 scopée au nœud (filtres/sort locaux) ; clic ligne → détail VM (`?vm=` conservé `?node` → retour au nœud).
- **Monitor nœud** (`components/node-monitor.tsx`, nouveau) : même expérience que le Monitor VM — **4 graphes empilés un par ligne + export CSV par graphe + export général**, timeframes 1 h / 24 h / 7 j / 30 j, auto-refresh 60 s. Graphes : CPU % (bandes de seuils overcommit.json), RAM %, Disque rootfs % (`storagePct` — repli RRD = usage rootfs nœud), Réseau RX/TX (bits/s). Alimenté par `fetchMetrics(tf, epId, node)` existant (`/api/metrics?node=`, InfluxDB d'abord + repli RRD → badge source). Fichiers CSV : `node-metrics-<nœud>-<scope>-<timeframe>-<date>.csv` (scopes `all/cpu/ram/disk/net`).
- **Factorisation** (`lib/monitor-charts.ts`, nouveau) : briques communes extraites de `vm-monitor.tsx` — `timeLabel`, `pctOption` (graphe 0–100 % + bandes de seuils optionnelles), `rateOption` (débits o/s·bits/s), `downloadCsvFile` (BOM UTF-8 + échappement). `vm-monitor.tsx` réécrit dessus, **comportement identique** (le graphe CPU conserve son remplissage `55` via `areaAlpha`).
- i18n fr/en : `vm.tab.vms` + `vm.node.insufficient` (le reste réutilise les clés existantes `metrics.*`, `node.kpi.*`, `nodes.*`, `vm.mon.export`).

### Validation
- typecheck web OK · **230 tests** (164 shared + 66 server — aucun code serveur/shared modifié) · build web OK (bundle `index-Cic4B7_5.js` servi sans restart).
- Validation visuelle : à faire par l'utilisateur sur `/vms` → clic nœud → 3 onglets.

---

## ✅ Fait — IP & MAC par interface dans le détail VM (Résumé + Réseau), via le guest agent (livré, validé tests/build/typecheck + E2E cluster réel — **commité**)

Demande utilisateur (2026-10-26) : « dans l'inventaire, il manque des informations comme adresse IP et MAC par interface. dans réseaux et résumé. »

### Constats sur le cluster réel — et correction d'un diagnostic erroné
- La config PVE donne déjà la **MAC par interface** (`net0: virtio=BC:24:…,bridge=vmbr0` / LXC `hwaddr=`) — parsée dans `ParsedVmNet.mac`, affichée dans l'onglet Réseau mais **absente du Résumé**.
- **Diagnostic initial (erroné, corrigé)** : « le guest agent ne rapporte pas ses interfaces (qemu-ga trop ancien) ». En réalité PVE 9 a simplement **supprimé** le champ `network-interfaces` de `/status/current` (absent de la réponse live ET du schéma API officiel — vérifié dans `pve-docs` master). Le qemu-ga des invités est parfaitement fonctionnel (`guest-network-interface` existe depuis QEMU 1.1).
- **Découverte décisive** : l'endpoint dédié **`GET /nodes/{n}/qemu/{vmid}/agent/network-get-interfaces`** (pass-through du guest agent) **existe dans PVE 9.1.1 et fonctionne sur ce cluster** — les 4 VMs QEMU rapportent IP+MAC par interface (ex. VM 102 : `ens18 bc:24:11:cd:93:70 → 192.168.1.190/24 + IPv6 global`, `ens19 → 192.168.100.190/24`). Réponse : `data.result[] = {name, hardware-address, ip-addresses[{ip-address, prefix, ip-address-type}]}`. VM arrêtée / LXC → erreur gérée → `[]`.
- Conséquence : **rien à installer côté invités** — les agents étaient déjà en place et opérationnels.

### Implémentation
- **Shared** (`network.ts`) : type `VmAgentNetIf {name, mac, ips[]}` + fonction pure **`matchAgentNetsByMac(nets, agentNets)`** — jointure interfaces agent ↔ config PVE par MAC (insensible à la casse, fusion multi-ifaces même MAC, dedup) ; les ifaces agent absentes de la config (docker0, veth…) sont ignorées. 5 tests dédiés.
- **Serveur** : `ProxmoxClient.getVmAgentNets(node, vmid)` (filtre `lo`, exclut loopback 127./::1 et link-local fe80::, `[]` en cas d'erreur) + méthode dans l'interface `DataSource` + mock déterministe (même MAC que config net0 via `mockMac`, IP `10.9.x.y/24`).
- **Route** `/api/vm-config` : champ `agentNets` ajouté à `VmDetailResponse` — fetch à la demande **QEMU running uniquement**, cache 60 s par (endpoint, vmid).
- **Web** (`vm-detail.tsx`, v2) :
  - **Résumé** : panneau **« Interfaces réseau »** — une ligne par interface : `net0 → vmbr0 (VLAN 100) · BC:24:… · 192.168.1.180/24` (IP = jointure guest agent pour QEMU, config statique pour LXC) ; la ligne « Adresses IP » = union des IPs par interface, repli sur `vm.ipAddresses` live (`/cluster/resources`).
  - **Réseau** : cartes par interface avec **IP réelle** (jointure agent) au lieu de « — » pour QEMU ; bandeau « IPs détectées (live) » conservé en complément quand `/cluster/resources` rapporte des IPs.
- i18n fr/en : `vm.sum.interfaces` + `vm.net.liveIps` (livraison précédente, toujours valables).

### Validation
- typecheck web OK · **235 tests** (169 shared dont 5 nouveaux + 66 server) · build web OK (bundle `index-soZEruZZ.js`).
- **E2E sur le cluster réel** (script tsx contre l'API PVE avec le token de l'app) : parsing correct sur les 4 VMs QEMU (IPv6 global conservé, fe80/loopback filtrés), LXC via path qemu → `[]`.
- Serveur **relancé** (`./server.sh restart` — code serveur modifié) ; health OK, mock:false.
- Validation visuelle : à faire par l'utilisateur sur `/vms` → clic VM → onglets **Résumé** (panneau Interfaces réseau avec IPs) et **Réseau**.

---

## ✅ Fait — Topologie réseau alimentée par les IPs du guest agent (livré, validé tests/build/typecheck + E2E cluster réel — **commité**)

Demande utilisateur (2026-10-26) : « il faut mettre à jour topologie reseau » → maintenant que les IPs par interface existent via le guest agent (section précédente), la page `/topology` les consomme **partout** : panneau de détail VM (table des interfaces), détail d'interface, inventaire réseaux→VMs (colonne IP), recherche unifiée et export CSV.

### Implémentation
- **Shared** (`network.ts`) : `TopologyVm.agentIps?: Record<string, string[]>` (iface → liste complète v4+v6) + helper pur **`primaryAgentIp(ips)`** (IPv4 d'abord, sinon première — 3 tests).
- **Serveur** :
  - `ProxmoxClient.getVmAgentNets` : cache 60 s **déplacée dans le client** (`agentNetsCache`, partagée par toutes les routes) ; la route `/api/vm-config` s'appuie dessus (cache locale supprimée, garde QEMU running conservée).
  - `computeTopology` (supervision) : pour chaque QEMU en marche, jointure `matchAgentNetsByMac(config.nets, agentNets)` via le helper pur exporté **`enrichVmAgentIps(nets, agentNets)`** — complète `nets[].ip` avec l'IP primaire quand la config n'en a pas + expose `agentIps`. LXC : inchangé (IP statique de config). VM arrêtée : aucun appel agent.
- **Web** (`topology.tsx`) : DetailPanel VM (table interfaces) et détail iface affichent la **liste complète** (`agentIps[iface].join(', ')`) quand le guest agent en rapporte plusieurs, sinon l'IP enrichie de config. Inventaire/CSV/recherche : alimentés automatiquement par `nets[].ip` enrichi (pas de changement).
- **Tests serveur** : nouveau `supervision/routes.test.ts` — 5 tests d'`enrichVmAgentIps` (primaire v4, non-remplacement config LXC, ifaces non jointes ignorées, référence inchangée si agent vide, iface sans IP absente).

### Validation
- typecheck web OK · **243 tests** (172 shared + 71 server) · build web OK.
- **E2E sur le cluster réel** (route `/api/network-topology` via fastify inject + ProxmoxClient avec le token de l'app) : VM 100 `192.168.1.180/24` + `192.168.100.180/24` · VM 102 `192.168.1.190/24` (primaire v4) + liste complète avec l'IPv6 global `2a01:cb14:…/64` · VMs 104/105 les deux interfaces · LXC 101 IP de config · LXC 103 sans IP → « — » (honnête).
- Serveur **relancé** (`./server.sh restart`) ; health OK, mock:false.
- Validation visuelle : à faire par l'utilisateur sur `/topology` → clic VM (ex. **NFS**) → table des interfaces + clic ligne = détail iface avec IPs.

### Ajout — LXC `ip=manual` / `ip=dhcp` affichées « manuelle » / « DHCP » (et non « — »)
Constat utilisateur : la LXC 103 (AMD-IA) n'avait pas d'IP affichée. Vérifié sur le cluster : sa config PVE est `net0 = …,ip=manual,type=veth`. Implémentation initiale : `ParsedVmNet.ipMode?: 'manual' | 'dhcp'` (parsing LXC) + `NetworkVmRef.ipMode` (inventaire) + affichage du libellé (`common.ip.manual`/`common.ip.dhcp`) dans le détail VM v2 (Résumé + Réseau), la topologie (table VM + détail iface) et l'inventaire réseaux→VMs. Validé E2E (VM 103 → `ipMode=manual`).

**Mise à jour (découverte PVE 9)** : contrairement au constat initial, **PVE ≥ 9 expose les interfaces live des LXC** via `GET /nodes/{n}/lxc/{vmid}/interfaces` — lecture côté hôte du netns du conteneur, **sans agent**, même avec `ip=manual` (même forme de réponse que l'endpoint QEMU guest-agent). Implémenté dans `ProxmoxClient.getLxcInterfaces` + parsing partagé `parseLiveNets` (filtre lo/loopback/link-local) ; la jointure par MAC et l'enrichissement topologie fonctionnent donc **aussi pour les LXC** (VM 103 → `192.168.1.188/24` + IPv6 global, validé E2E). Le libellé `ipMode` ne s'affiche plus que si l'endpoint est indisponible ou la VM arrêtée.

---

## ✅ Fait — Correction des graphiques Monitor des nœuds Proxmox (réseau à zéro + trous de données) (livré, validé E2E cluster réel — **commité**)

Demande utilisateur (2026-10-26) : « il y a des problèmes sur les graphiques de monitor des noeuds proxmox. Il faut corriger le bug. »

### Diagnostic
- **Bug #1 — réseau plat à zéro** : PVE ≥ 9 ne renvoie plus `netin`/`netout` dans `GET /nodes/{n}/status` (vérifié sur 9.1.1 ; `/nodes/{n}/status/current` inimplémenté, `/nodes/{n}/network` = config sans stats) → le poller écrivait 0 → graphique Réseau à zéro. Les RRD du nœud (`/nodes/{n}/rrddata?cf=AVERAGE`) contiennent encore les vraies valeurs (804 pts non nuls/jour).
- **Bug #2 — trous de données** : la base `raw` ne contenait que l'historique poller (arraché par les arrêts serveur) ; les timeframes `week`/`month` renvoyaient quelques points.
- **Bug #3 (découvert en route) — `cluster` mot-clé DuckDB** : les 2 requêtes `storage_metrics` de `/api/metrics` + `/api/capacity` échouaient en silence (`ParserError: found: cluster`) → repli rootfs permanent. `cluster` nu en SELECT est rejeté par le parser InfluxDB 3 (mot-clé contextuel) ; il faut `"cluster"` avec guillemets.
- **Bug #4 (découvert en route) — limite de fichiers Parquet d'InfluxDB 3 Core** : défaut `--query-file-limit=432` ≈ 72 h de données → toute requête 30 j sur `consolidated` échouait (`Query would scan 432 Parquet files, exceeding the file limit`) → le timeframe `month` tombait en repli RRD.

### Implémentation
- **Mesure dédiée `node_net`** (tags `cluster`+`node`, champs `net_in_bps`/`net_out_bps` bits/s) : le trafic réseau du nœud = **somme des VMs en marche** (même convention que le KPI réseau du dashboard, zéro appel API supplémentaire). Le poller (`poller.ts writeInflux`) n'écrit plus de net dans `node_metrics` (cpu/ram/disk uniquement) ; les lignes historiques `node_metrics` à net=0 restent en place (InfluxDB 3 Core **sans DELETE**) et ne sont plus lues pour le réseau → pas de dilution.
- **Lecture** (`dashboard/routes.ts metricsFromInflux`) : 2 requêtes parallèles (`node_metrics` cpu/ram/disk + `node_net` net) jointes en JS par `(bucket, nœud)` avant `aggregateNodeRows` (inchangé). `node_net` absente (installation fraîche) → réseau à zéro sans repli RRD.
- **Consolidateur** (`influx-consolidator.ts`) : bloc `node_metrics` sans net + nouveau bloc `node_net` (agrégation 5 min identique).
- **Backfill RRD one-shot** (script tsx, supprimé après usage) : par endpoint × nœud, fusion des timeframes RRD `day`/`week`/`month`/`year` par timestamp (le plus fin gagne) → écriture dans `raw` de `node_metrics` (cpu_pct/ram_pct/disk_pct calculés depuis les capacités **par point** : `maxcpu`/`memtotal`/`roottotal`) + `node_net` (netin/netout). 5 976 lignes, couverture : 1 min (24 h) · 30 min (30 j) · ~15 h (1 an). Reset de `data/consolidation-state.json` → le consolidateur ré-agrégé toute l'historique vers `consolidated` au redémarrage (tranches 1 j). **Piège évité** : le reset doit se faire **serveur arrêté**, sinon l'instance en cours réécrit son propre `lastTs` à l'arrêt.
- **`docker-compose.yml`** : `--query-file-limit=10000` sur le service InfluxDB (marge de plusieurs années à ~30 fichiers/jour/table). Appliqué aussi au checkout principal (le conteneur en production tourne depuis `/home/opencode/projet/proxmox`).
- **Quoting `"cluster"`** dans les 2 requêtes `storage_metrics` (SELECT + GROUP BY) — le pattern du consolidateur (`COALESCE(cluster, …)`) fonctionne tel quel (vérifié).

### Validation
- **E2E** (app in-process + fastify inject, session admin) : les 4 timeframes × 2 endpoints renvoient `source: influx` avec réseau non nul sur tous les points disponibles — `proxmox` : hour 59/61 · day 163/163 · week 43/43 · month 10/10 ; `clusterproxmox` : 37/61 · 156/160 · 40/40 · 9/9.
- **Cohérence des valeurs** : `node_net` (5.54e10 bits/s) = somme live des `netin` des VMs en marche (949 + 136 + 300 + 27 122 + 26 890 Mbit/s ≈ 55,4 Gbit/s — trafic réel des nœuds virtuels ProxSite1/2).
- 243 tests (172 shared + 71 server) · typecheck web OK · build web OK.
- **Note contexte** : les nœuds sont des nœuds de test/dev pas toujours allumés → les trous de données quand un nœud est éteint sont **attendus**, pas un défaut du pipeline. Architecture InfluxDB confirmée : 2 bases `raw` (31 j, points bruts) + `consolidated` (∞, **points tous les 5 min**).
- Validation visuelle : à faire par l'utilisateur — `/vms` → nœud → onglet Monitor (les 4 graphiques dont Réseau) + vue dashboard.

---

## ✅ Fait — Module « Alarmes & Centreon » (centreon-nsca) (livré, validé API + Playwright — **commité**)

Demande utilisateur (2026-10-30) : créer un module complet qui définit des règles de surveillance sur les VMs/nœuds Proxmox, génère des alarmes, et les transmet à **Centreon** via **NSCA (`send_nsca`)** en **checks passifs**, avec activation/désactivation des règles, choix d'un poller cible, et **provisionnement automatique du service Centreon** via **CLAPI** **ou** **API REST v1** (choix sur la page de config). Nom `centreon-nsca` (un backend Zabbix viendra ensuite — namespace `/api/alarms/*` générique).

### Itération 2 (2026-10-30) — pollers avec IP + renommage + ajout de mapping
Demande utilisateur : « pour la gestion des Pollers, il faut deux entrées — le nom et l'IP ; changer le nom du module **Alarmes & Checks NSCA → Alarmes & Centreon** ; pour le **Mapping VM → Hôte Centreon**, il faut un bouton **Ajouter** pour d'autres correspondances. »

- **Pollers = nom + IP** : `CentreonPoller.ip` (shared) ; la Page 3 affiche une entrée IP par poller + une ligne d'ajout (nom + IP). L'**IP du poller est la destination NSCA** des trames de ses règles (`engine.ts` : `poller?.ip || cfg.nsca.server`), avec repli sur le serveur NSCA du central si vide. `store.setPollers` conserve/nettoie l'IP. Test store dédié.
- **Renommage « Alarmes & Centreon »** : i18n fr/en (`nav.alarms`, `alarm.title`), manifest du plugin, `DEFAULT_MODULES` (shared/auth.ts), titre README + skill. Le nom du **catalogue** (data/auth.json, seedé avant le renommage) a été mis à jour manuellement — `syncModuleCatalog` ne met à jour que les entrées manquantes, pas les noms existants (point de vigilance pour les futurs renoms de module).
- **Mapping VM→Hôte : bouton « Ajouter »** : la Page 3 charge les cibles (`GET /api/alarms/targets`), propose un dropdown VM + champ hôte (auto-suggestion `suggestCenteronHost`), et ajoute la correspondance (persistance via `PUT /api/alarms/config`).

**Validation itération 2** : 313 tests (217 shared + 96 server) · typecheck web propre · build OK · Playwright — menu/catalogue « Alarmes & Centreon », onglet admin (IP des pollers pré-remplies, ligne d'ajout nom+IP, bouton Ajouter du mapping avec auto-suggestion et persistance), Page 2 inchangée.

### Périmètre livré
- **3 pages** : `/alarms` (tableau des règles : filtres, recherche, tri, indicateurs, activer/désactiver, Tester, Reprovisionner, Modifier, Supprimer), `/alarms/new` (formulaire de création → provisionne le service Centreon puis enregistre la règle + récap), et **Page 3 = onglet « Centreon (NSCA) »** de la page Administration (activation du module, transport CLAPI/REST v1, central, pollers, serveur NSCA, mapping VM→hôte Centreon).
- **Engine d'alarmes** (tick 15 s) : évalue les règles actives sur le snapshot poller (ring-buffer mémoire, pas de dépendance InfluxDB), machine à états ok⇄firing, envoie une trame `send_nsca` à chaque transition (alarme = code sévérité 1/2/3, récupération = 0). Fenêtre de confirmation (la condition doit persister X minutes).
- **Provisionnement** : CLAPI (mode **SSH** — Prox4u hors central — ou local) **ou** REST v1. Les deux créent le service passif (`passive_checks_enabled=1`, `active_checks_enabled=0`, `is_volatile=1`, `max_check_attempts=1`, `check_command=check_dummy!0`) puis **génèrent + déploient** la config du poller (`POLLERGENERATE`/`CFGMOVE` ou `config/generate`+`config/move`).
- **Sécurité** : mots de passe CLAPI/NSCA/token REST jamais loggués, jamais renvoyés en clair par l'API (masqués `••••••`, « inchangé » si renvoyés tels quels) ; échappement des `;` et retours à la ligne dans les noms d'hôte/service contre l'injection de trame NSCA.
- **Robustesse** : échec CLAPI/REST ou `send_nsca` → la règle reste enregistrée, statut provisioning/transmission `erreur` + message, aucun crash. Module désactivé = engine inerte.

### Fichiers
- `packages/shared/src/centreon-nsca.ts` (+ `.test.ts`, 23 tests) : types + fonctions pures (return code, échappement, trame, rendu template, nom de service, auto-suggestion hôte, évaluation fenêtre, `nscaCfgContent`, `clapiProvisionCommands`).
- `packages/server/src/modules/centreonnsca/` : `store.ts` (data/centreon-nsca.json), `metrics.ts`, `engine.ts`, `nsca.ts` (spawn send_nsca + détection du support `encrypt`), `provision.ts` (CLAPI ssh/local + REST v1), `routes.ts` (`/api/alarms/*`), `index.ts` (+ 19 tests).
- `packages/web/src/plugins/centreon-nsca/` : `index.ts` (manifest), `lib/nsca-api.ts`, `pages/{rules,create-rule,edit-rule}.tsx`, `components/rule-form.tsx`.
- `packages/web/src/components/admin/nsca-config.tsx` (Page 3) + onglet dans `pages/admin/index.tsx`.
- Câblage : `features.ts` (`VITE_USE_PLUGIN_CENTREON_NSCA`), `plugins.ts`, `app.tsx` (fallback ModuleDisabled), `DEFAULT_MODULES` (shared/auth.ts), i18n fr/en (`alarm.*`, `nav.alarms`, `admin.tab.nsca`).
- Docs : `skills/centreon-nsca/SKILL.md` (+ symlink + inventaire `skills/README.md`), section README « Module Alarmes & Checks passifs NSCA », `scripts/nsca-test.sh` (test manuel NSCA).

### Pièges corrigés pendant la livraison
- **Format `send_nsca.cfg`** : le séparateur imposé est ` = ` (pas un espace simple) → `server = hôte`, `port = 5668`… (le format à l'echec rejetait tout le fichier).
- **Support de `encrypt` variable** : certains builds de `send_nsca` (ex. le fork Debian `nsca-client`, celui de cet environnement) **ne connaissent pas** `encrypt` (ni en cfg, ni en CLI) et rejettent le fichier (`Unknown variable name 'encrypt'`) → **sonde de détection à l'exécution** (`probeEncryptSupport`) qui teste le binaire une fois et n'émet `encrypt` que si le build l'accepte. Portable entre builds.
- **Chemin du binaire** : `send_nsca` est dans `/usr/sbin` (pas toujours dans le PATH) → détection PATH + emplacements usuels + override `SEND_NSCA_BIN`.

### Validation effectuée
- **Tests** : 217 shared (dont 23 centreon-nsca) + 95 server (dont 19 centreonnsca) passent · typecheck web 100 % propre · build web OK.
- **API E2E** (session admin) : `GET /api/alarms` (règles+pollers+stats+config), `PUT /api/alarms/config` (activation+NSCA, mdp masqués à la relecture), `POST /api/alarms/rules` (création + **provisioning échoué proprement** sans central réel → `provisionStatus:error` + message SSH, règle conservée), `POST /api/alarms/rules/:id/test` (trame NSCA : le cfg passe le parsing, échec de connexion attendu sans daemon), `GET /api/alarms/targets` (VMs/nœuds réels + mappings).
- **Playwright** : les 3 pages validées — menu « Alarmes & Checks NSCA », Page 2 (tableau + indicateurs + filtres + actions), Page 1 (formulaire peuplé + auto-suggestion hôte/service), Page 3 (onglet admin : transport CLAPI/REST, central, NSCA, pollers, mapping).
- **Note** : le daemon NSCA n'est pas installé sur cet environnement (seul le client `send_nsca` l'est) → la réception côté Centreon est à valider avec un vrai daemon (script `scripts/nsca-test.sh` fourni). Le mot de passe admin a été réinitialisé en local pour la validation (`***`).

### Roadmap (hors périmètre de cette itération)
- Backend **Zabbix** (2ᵉ transport d'alarme) sur le même namespace `/api/alarms/*`.
- Nettoyage CLAPI du service Centreon à la suppression d'une règle (actuellement : le service reste en place, nettoyage manuel).
- Historique des alarmes / agrégats au-delà des 24 h.

---

## ✅ Fait — Agent PVE (colonne + alerte + compteur), menu déroulant, titres de page (livrés, validés tests/build + Playwright — **commités**)

Trois livraisons UI du 2026-10-30, toutes « sans rien casser » (routes, layout persisté et données inchangés).

### 1. Colonne « Agent PVE » + alerte critique + compteur (UI seule, zéro métrique NSCA)
- **Source unique `agentActive: boolean | null`** : `true` = QGA répond (`get-fsinfo` ok, y compris `[]`) · `false` = VM QEMU en cours mais agent non démarré (**critique**) · `null` = n/a (LXC, arrêtée, template) ou inconnu (cache pas réchauffé au démarrage).
- **Zéro appel API additionnel** : capturée dans le **réchauffage agent déjà existant du poller** (`refreshAgentData`, `EndpointState.agentActive: Map<vmid,boolean>`). La route inventaire dérive le sien de `fs !== null` qu'elle reçoit déjà.
- Ajoutée à `VmSummary`, `InvVm`, `KpiSummary` (`vmsAgentDown`).
- **Vue VM v2** : colonne « Agent PVE » (badge vert/rouge/« — »), triable (inactif d'abord en asc, nulls last).
- **Inventaire Proxmox** : même colonne + **filtre par colonne** (actif/inactif/n-a) + tri ; le compteur « Agent OK » de l'en-tête passe à l'état **exact** (`agentActive === true`) — remplace l'ancienne heuristique interfaces/disques.
- **Vue générale** : sous-ligne dans la carte « VMs & conteneurs » existante (pas de nouvelle carte, le layout persisté est conservé) — rouge « N VM(s) sans agent PVE » si > 0, sinon « agents PVE OK ».
- i18n : `vm.col.agent`/`vm.agent.*`, `pxinv.col.agent`/`pxinv.agent.*`, `kpi.vmAgentDown`/`kpi.vmAgentOk`.

### 2. Menu déroulant — section « PROXMOX » supprimée, sous-menu sous « Vue d'ensemble »
- La section « PROXMOX » (endpoints→nœuds) du sidebar est **supprimée** et transformée en **sous-menu repliable** niché sous l'item « Vue d'ensemble ».
- Mécanique générique sur `PluginMenuItem` : `submenu` (ReactNode) + `statusDot` (composant) — validées zod. **Chevron dédié** : clic label = navigation, clic chevron = repli/dépliage. **État persisté** `navTreeExpanded` dans `store/layout` (replié par défaut, mémorisé). `EndpointFleetDot` = pastille de santé **agrégée** (crit > warn > ok > neutre), visible même repliée.
- Liens = les mêmes routes (`/e/:endpointId`, `/e/:endpointId/n/:nodeId`) — zéro changement de route.
- `plugins/hypervision/index.ts` **renommé `index.tsx`** (JSX dans le manifest).

### 3. Titres de page (cohérence avec tous les modules)
- **Convention** (consignée dans le skill `general` §5) : **chaque page = `h1` à gauche (`text-lg font-semibold`) + ligne d'aide (`text-xs` muted)** ; bouton retour (←) sur les pages de détail.
- **Vue d'ensemble** : `h1` « Vue d'ensemble » + aide (`overview.hint`).
- **Cluster (endpoint)** : bouton retour → Vue d'ensemble + `h1` = nom du cluster + aide (`endpoint.hint`).
- **Nœud** : titre passé en `h1` (était `div text-xl`) — boutons retour + badges statut/surallocation + IP/version/uptime conservés.

### Vérifications effectuées
- `pnpm typecheck` (3 packages) + `pnpm test` (**224 shared + 112 server**) + `pnpm build` : OK. **4 tests ajoutés** (tri `agentActive` ×2, filtre agent, `agentOk` exact).
- **Playwright (cluster réel)** : menu replié/déplié validé (chevron, pastille, liens endpoints/nœuds) ; les 3 pages avec leur titre + aide ; colonne agent (5/5 VMs actives, `vmsAgentDown`=0, LXC/arrêtées = null).
- **Vérif live du vrai client** (`getAgentBundle`, même chemin que le poller) : proxmox 100/102/104/105/106 = agent actif, 101/103 (LXC) = n/a · clusterproxmox 100/2101 (arrêtées) = n/a → `vmsAgentDown` = 0.
- i18n : après ajout des clés `overview.hint`/`endpoint.hint`, **rebuild du `dist` shared obligatoire** (sinon la clé brute s'affiche) — voir skill `general` §10.

### Pièges rencontrés (corrigés)
- **JSX dans le manifest** : `submenu: <ProxmoxNavTree />` dans `index.ts` → `tsc TS1005` → renommé `index.tsx`.
- **Clé i18n brute affichée** : le web lit le `dist` buildé de `@proxmox/shared` → rebuild shared requis après toute clé i18n.
- **`vmsAgentDown` construit avant les `vmSummaries`** : le calcul est placé avant la construction de `kpis` (pas après), sinon les `agentActive` ne sont pas encore renseignés.

---

## ✅ Fait — Module « Capteurs nœuds » (node-sensors v1) + déploiement Telegraf (livré, validé cluster réel — **commité**)

Demande utilisateur : exposer les **métriques locales** que l'API PVE ne donne pas (SMART,
températures, ZFS ARC, unités systemd) dans un nouveau module du dashboard. **Option A** actée :
nouvelle famille de plugin `node-sensors` v1, **aucun module existant touché**.

### Périmètre livré
- **Telegraf bare-metal sur les 3 nœuds Proxmox** (`proxmox` 192.168.1.80, `ProxSite1`,
  `ProxSite2` — cluster 192.168.1.201) : 9 tables actives dans `raw` (`smart_device`, `sensors`,
  `zfs`, `systemd_units`, `disk`, `diskio`, `mem`, `cpu`, `system`). ProxSite2 sans capteurs
  (`sensors` vide — normal, pas de lm-sensors détecté).
- **Module web `node-sensors` v1** : page `/node-sensors` (menu order 70) avec 4 tableaux
  (SMART, capteurs, ZFS ARC, unités systemd) + filtre multi-choix des sections + filtres colonnes.
- **Consolidation Telegraf 15 min** : le consolidateur agrège `smart_device`, `sensors`, `zfs`,
  `systemd_units` de `raw` (31 j) vers `consolidated` (∞) — historique infini.
- **Filtres colonnes multi-choix** : dropdown `position:fixed` (pas de coupure par l'overflow du
  tableau), fond opaque `#0f1117`, option « Tous » en haut (coche = tout sélectionner, décoche =
  tout libérer). Même traitement pour le dropdown « Sections » (« Toutes »).

### Fichiers
- `deploiement/60-telegraf-nodes.sh` : script de déploiement Telegraf (bare-metal, `--dry-run`,
  idempotent). `TELEGRAF_INFLUX_TOKEN` (requis), `insecure_skip_verify`, override systemd
  `User=root` (accès aux devices raw).
- `packages/shared/src/node-sensors.ts` : types partagés (`SmartDevice`, `SensorReading`,
  `ZfsStatus`, `FailedUnit`, `NodeSensorsResponse`).
- `packages/server/src/modules/nodesensors/` : `routes.ts` (`GET /api/node-sensors`, cache 1 min,
  try/catch par section), `index.ts`.
- `packages/web/src/plugins/node-sensors/` : `index.ts` (manifest), `pages/node-sensors.tsx`.
- `packages/server/src/core/influx-consolidator.ts` : consolidation 15 min des tables Telegraf.
- Câblage : `features.ts` (`USE_PLUGIN_NODE_SENSORS`), `plugins.ts`, `DEFAULT_MODULES`
  (shared/auth.ts), i18n fr/en (`nav.nodeSensors`, `nodeSensors.*`).

### Pièges corrigés pendant la livraison
- **`source: 'empty'` systématique** : les colonnes ZFS s'appellent `arcstats_hits`,
  `arcstats_misses`, `arcstats_size` (pas `arc_hits`). Une requête sur une colonne inexistante
  levait une erreur qui faisait échouer la section → **try/catch par section** (pas un seul bloc).
- **`health_ok` boolean** : InfluxDB 3 renvoie un boolean `true` (pas un nombre) →
  `(r.health_ok as unknown) === true` + repli sur `1`/`'true'`/`'True'`.
- **Filtres superposés/illisibles** : le dropdown initial était transparent et coupé par
  l'overflow du tableau → `position:fixed` calculé depuis `getBoundingClientRect()`, fond opaque,
  `z-50`.

### À suivre (plan de travail)
- **Règles d'alarme** (SMART critique, température > seuil effectif, unité échouée) dans
  `centreonnsca` (skill `centreon-nsca`) — peut maintenant s'appuyer sur les **seuils perso**
  (livrés, section « Fait » ci-dessous) : le moteur lira `sensorThresholds` +
  `effectiveSensorThreshold`. → [`docs/plan-seuils-capteurs.md`](docs/plan-seuils-capteurs.md)
- **Seuils capteurs personnalisés** + **correctif tri-state SMART** : livrés, voir section
  « Fait » ci-dessous.
---

## ✅ Fait — Seuils capteurs personnalisés + correctif tri-state SMART (livré, **commité**)

Demande utilisateur : **abaisser le seuil d'alerte par capteur** (perso ≤ firmware, jamais
au-dessus), persisté et éditable. Puis, sur un constat de terrain — les disques virtuels
QEMU (`ProxSite1/2 sda`) affichaient « CRITIQUE 0°C » — un **correctif tri-state SMART** pour
anticiper du **vrai matériel** (RAID, disques sans SMART), pas un maquillage cosmétique.

### Périmètre livré
- **Seuils capteurs personnalisés** : seuil perso **≤ firmware** (clamp input `max` + clamp
  serveur au PUT, valeurs invalides ≤ 0 ignorées), persistance `data/sensor-thresholds.json`
  (écriture atomique tmp+rename, chmod 600, fail-fast). Onglet Administration « Seuils
  capteurs » (nœud/puce/capteur/temp/seuil firmware RO/seuil perso input + reset par ligne +
  tout). **Le tableau capteurs suit le seuil EFFECTIF** (perso sinon firmware) via
  `tempTone`/`effectiveSensorThreshold` ; sans seuil → repli historique 80/60 °C.
- **Routes** : `GET/PUT/DELETE /api/admin/sensor-thresholds` (+ `DELETE .../:node/:chip/:feature`)
  — guard rôle admin (préfixe `/api/admin/*`). Merge des seuils perso dans `GET /api/node-sensors`
  (`sensorThresholds`) — lecture accessible aux users du module.
- **Correctif tri-state SMART** : `healthOk` devient `boolean | null` — `true`=PASSED,
  `false`=FAILED, `null`=**inconnu** (disque virtuel / volume RAID / état illisible). NULL n'est
  **pas** un échec : mapper NULL → `false` affichait « CRITIQUE » sur des disques sans SMART
  (faux positif qui polluerait le monitoring sur du vrai matériel). Badge gris « Inconnu », la
  valeur est proposée dans le filtre santé. `parseHealthOk` (routes.ts) + consolidateur 15 min
  préservent le NULL. `0 °C` = pas de lecture (`smartTempDisplay`) → affiché « — ».
- **Fonctions pures shared testées** : `sensorKey`, `effectiveSensorThreshold`, `tempTone`,
  `smartHealthTone`, `smartTempDisplay`.

### Fichiers
- `packages/shared/src/node-sensors.ts` : types seuils + `healthOk` tri-state + fonctions pures.
- `packages/server/src/modules/nodesensors/thresholds.ts` : `SensorThresholdStore` (NOUVEAU).
- `packages/server/src/modules/nodesensors/routes.ts` : routes admin + merge + `parseHealthOk`.
- `packages/server/src/core/influx-consolidator.ts` : agrégat 15 min SMART préserve le NULL.
- `packages/web/src/components/admin/sensor-thresholds.tsx` : onglet admin (NOUVEAU).
- `packages/web/src/plugins/node-sensors/lib/sensor-thresholds-api.ts` : client API (NOUVEAU).
- `packages/web/src/plugins/node-sensors/pages/node-sensors.tsx` : seuil effectif + tri-state.
- `packages/web/src/pages/admin/index.tsx` : onglet ajouté.
- i18n fr/en : `sensorThresholds.*`, `nodeSensors.unknown`, `nodeSensors.threshold*`.

### Tests
- **236 shared + 127 server, tous verts** — dont 12 tests fonctions pures (seuils + tri-state),
  7 tests store, 8 tests routes admin (clamp, validation, merge), 5 tests parsing SMART tri-state
  (QEMU/RAID → `null`, PASSED/FAILED, représentations 1/0/'true'/'false', `0 °C` conservé).
- Correctif incident pré-existant : `auth/store.test.ts` (3 assertions liste modules) ne
  contenait pas `node-sensors` (ajouté à `DEFAULT_MODULES` lors de la livraison v1 antérieure).

### Pièges corrigés
- **Faux positif « CRITIQUE » sur disques sans SMART** : `health_ok = NULL` (QEMU, RAID) était
  mappé en `false` → « CRITIQUE ». Tri-state `boolean | null` + `smartHealthTone` → « Inconnu ».
- **Consolidateur `num(true)` → 0** : `num()` rendait 0 même pour un boolean `true` → le bucket
  15 min avait toujours `health_ok=0` (= FAILED). Maintenant `health_ok` n'est écrit que si la
  fenêtre en contient une valeur, avec le bon mapping true→1/false→0.

---

## ✅ Fait — Bug 1 : dédoublonnage du stockage iSCSI / VG LVM (livré, **commité**)

Bug signalé par l'utilisateur : le graphe « Disque — 7 jours » affichait une allocation à **916 %**,
et le cluster `clusterproxmox` montrait **655 GB** de stockage au lieu de ~333 GB. Diagnostic :
une cible iSCSI (`baie-iscsi`, type `iscsi`) porte un VG LVM (`Lun-iscsi`, type `lvm`) — PVE
remonte le **même volume de 322 GB deux fois** (datastore `iscsi` + datastore `lvm` dont le champ
`base` = « baie-iscsi:… »), et le poller sommait les deux → double-comptage.

### Correction
- **`PveStorage.duplicateOf?: string`** (shared/types.ts) : posé quand la capacité du datastore est
  déjà représentée par le datastore nommé (même volume physique vu deux fois).
- **Helper pur `iscsiHostVg(storages, iscsiName)`** (prox4u-client.ts, exporté, **4 tests**) :
  renvoie le VG LVM dont le champ `base` référence la cible iSCSI (`« {iscsi}:… »`). C'est le
  **signal robuste** — pas une heuristique de taille (total/used identiques). Le VG pointe vers une
  autre cible → `undefined` ; préfixe exact (`baie` ne matche pas `baie-iscsi`).
- **`getStorage()`** : pour chaque datastore `iscsi` qui a un VG dessus, `duplicateOf` = nom du VG
  lvm. La vue iSCSI est **écartée** (redondante) ; la vue **`lvm` est conservée** (c'est là que sont
  les disques VM, `scsi0: Lun-iscsi:vm-2101-disk-0`).
- **Poller** : `storWithCap` exclut tout datastore `duplicateOf` des sommes
  `storageTotalBytes`/`storageUsedBytes` (l.230). L'inventaire stockage (`/api/storage-inventory`)
  liste chaque datastore sans total agrégé → pas de double-comptage là (inchangé).

### Vérifications effectuées
- `pnpm --filter @proxmox/shared build` → `pnpm typecheck` → `pnpm -r test` (**242 shared + 136
  server verts**, +4 `iscsiHostVg`) → `pnpm build` → `./server.sh restart` : OK.
- **Vérifié live** (clusterproxmox) : `storageTotalBytes` 655,50 → **333,41 GB** ·
  `storageUsedBytes` 91,78 → **48,83 GB** · `storagePct` 14,6 % · `diskThinTotal` inchangé
  (4,69 GB → **Bug 2 intact**, à traiter ensuite).

### Piège retenu
- Ne **pas** dédoubonner par heuristique « même total + même used = doublon » : c'est fragile et
  **faux** sur du vrai matériel (deux baies identiques ≠ même volume). Le champ `base` du VG lvm
  est le seul signal fiable qu'il s'agit du même volume physique.

> **Bug 2 (ratio thin 916 %)** — résolu par la cartographie ci-dessous (ratio disk corrigé + n/a).

---

## ✅ Fait — Cartographie stockage : volumes physiques + ratio disk correct (livré, **commité**)

Suite du Bug 1/Bug 2. Demande utilisateur : « il faut un plan pour avoir une cartographie précise
du stockage » + « si un volume iSCSI de 300 Go porte un autre volume comme un LVM de 300 Go, on ne
peut pas dire qu'on a 600 Go, mais seulement 300 Go — il faut une analyse intelligente ».
Arbitrages : sémantique **thin = sur-allocation / thick = usage**, périmètre **A + B**, Phase B en
**section du `/storage` existant**, livraison **A puis B (A validée d'abord)**.

### Phase A — KPI disque correct (corrige le 916 %, 0 nouvel appel API)
- **`buildStorageVolumes(storages, alloc, config)`** (fonction pure shared, **11 tests**) : regroupe
  les datastores en **volumes physiques** (une cible iSCSI + son VG LVM = UN volume, capacité
  comptée **une fois** via `duplicateOf`/`iscsiHostVg`), classe **thin** (lvmthin/zfs/rbd →
  sur-allocation, peut >1) / **thick** (dir/lvm/nfs/iscsi/cifs → usage, ≤1), produit le ratio par
  volume + le **ratio global disk** = Σ disques sur thin / Σ capacité thin, **n/a si aucun disque
  sur un thin**.
- **Types partagés** : `StorageDiskAlloc`, `StorageVolume` ; `KpiSummary.diskThinAllocatedBytes`
  (nouveau) + `diskThinTotalBytes` redéfini (thin **qui hébergent des disques**) ;
  `DashboardSnapshot.storageVolumes`.
- **Poller** : agrège `diskAllocByStorage` depuis `VmSummary.disks[]` (Σ `size=`, templates
  exclus — la donnée était déjà collectée, simplement non agrégée), appelle `buildStorageVolumes`,
  dérive les KPI thin, pousse `storageVolumes`. **Mock** : `disks` synthétisés (démo).
- **`computeOvercommit`** : numérateur disk = `diskThinAllocatedBytes` (pas `diskAllocatedBytes`)
  → plus de mélange thick/thin. **UI** : carte surallocation + graphe disque corrigés, libellé n/a
  affiné.
- **Résultat clusterproxmox** : ratio disk **916 % → n/a** (les disques sont sur du thick) ;
  `Lun-iscsi`/`baie-iscsi` = **un volume de 322 GB** (pas 644), usage **13 %**.

### Phase B — Panneau « Volumes physiques » dans /storage
- **`components/storage-volumes.tsx`** : une carte par volume (nom + badge Thin/Thick + endpoint,
  capacité réelle comptée une fois avec barre utilisé/total, disques VM alloués + badge
  Sur-allocation ×N / Usage P% / n/a, nb VMs, **vues regroupées**). Calculé côté client depuis les
  données inventaire via `buildStorageVolumes` — **zéro nouvel appel API**. Respecte la vue
  (agrégée / endpoint). i18n `storage.volumes.*` (fr/en).

### Vérifications effectuées
- `pnpm --filter @prox4u/shared build` → `pnpm typecheck` → `pnpm -r test` (**255 shared** dont
  11 `storage-volumes` + 2 overcommit, **136 server** verts) → `pnpm build` → `./server.sh restart` : OK.
- **Cluster réel (8080)** : `/storage` → panneau volumes : `Lun-iscsi` = un volume **300 GB** (pas
  600), usage 13 %, « vues : baie-iscsi » ; vue `?view=clusterproxmox` n'affiche que ses volumes.
  Zéro erreur console.
- **Mock (8095)** : `ceph` (Thin) = sur-allocation **×0.05** (928 Go/20 To), `local-pve*` (Thick) =
  usage (64 %, 52 %…) ; `demo-b` (sans thin avec disques) → ratio n/a. Zéro erreur console.

### Pièges corrigés
- **Faux 916 %** : le ratio disk mélangeait tous les disques (numérateur) avec un dénominateur thin
  → corrigé : numérateur = disques **sur thin** uniquement, n/a si aucun.
- **Double-comptage 300/600 Go** : capacité du volume = celle de la vue de référence, **jamais la
  somme des vues** (regroupement via `duplicateOf`, pas d'heuristique de taille).

---

## ✅ Fait — Hiérarchie iSCSI → LVM (livré, **commité**)

Suite de la cartographie. Demande utilisateur : penser **vrai matériel** — un LUN iSCSI peut porter
**plusieurs VG LVM**, et la capacité du cluster doit refléter la **taille physique du LUN** (pas le
VG). Arbitrages user (3) : (1) taille LUN = **si connue, sinon Σ tailles VG** (borne basse + note
« LUN peut être plus grand ») ; (2) total stockage cluster = **taille LUN physique** ; (3)
hiérarchie affichée en **table + panneau volumes**. Sémantique : « utilisé » d'un LUN = **Σ tailles
des VG enfants (engagé)**, pas les données du VG (cas 600 Go LUN / 100 Go VG → 500 Go libres).

### Correction
- **`PveStorage.duplicateOf?: string[]`** (shared/types.ts) : posé **sur le LUN iSCSI** = la liste
  de ses VG enfants (un LUN peut porter plusieurs VG). Le LUN est le volume de référence.
- **`StorageVolume`** en **arbre** : `children: StorageVolume[]` remplace `duplicateViews` ;
  `totalSource?: 'lun' | 'vg-sum'` (borne basse quand la taille LUN est inconnue). `StorageRow`
  gagne `parentStorage?` (LUN dont le datastore est un VG enfant) pour la table.
- **`buildStorageVolumes(storages, alloc, config, lunSizes?)`** (fonction pure shared, **15 tests**) :
  construit l'**arbre iSCSI → LVM** (LUN parent, VG enfants, iSCSI brut autonome conservé). Capacité
  du LUN = `lunSizes[nom]` (valeur d'autorité) sinon **Σ tailles VG** (borne basse) ; utilisé du LUN
  = **Σ tailles VG (engagé)** ; ratio/tonalité par nœud ; ratio global disk recalculé sur l'arbre
  aplati (thin uniquement).
- **`storage-volumes.json`** (racine, optionnel) → `AppConfig.lunSizes` : `{ "lunSizes": { "<iscsi>": octets } }`,
  chargé au démarrage (pas de hot-reload — donnée de parc stable).
- **`iscsiHostVgs`** (prox4u-client.ts, exporté) : renvoie **tous** les VG dont `base` référence la
  cible iSCSI (`iscsiHostVg` = `[0]`, rétro-compat). `getStorage()` iSCSI : `duplicateOf` = liste des
  VG, used/total = **Σ tailles VG** (engagé / borne basse).
- **Poller** : **inversion du dédoublonnage** — `childVgNames` = ensemble des valeurs `duplicateOf`
  (les VG enfants) ; `storWithCap` **compte le LUN, exclut les VG** (avant : comptait le VG, écartait
  le LUN). Applique `lunSizes` aux totaux iSCSI. Dérive les KPI thin en **aplatissant l'arbre**.
- **Web** : panneau volumes en **arbre** (carte LUN parent **+ repliable** — chevron « Replier/Déplier
  le LUN », déplié par défaut — + VG enfants indentés, connecteur « └ » + « · sous {LUN} », note borne basse,
  **lu du snapshot WS** `storageVolumes` — source unique avec la config LUN, plus de recalcul
  client). Table iSCSI → LVM : **LUN parent dépliable**, VG enfants **indentés** (« · sous {LUN} », **cellule Serveur vide** — le serveur est déjà montré par le parent),
  drill-down VMs conservé. **Règle `expandable`** : une ligne est dépliable si VG enfants OU VMs OU **capacité connue** (`hasCapacity`) — un datastore « local » sans VM (dir ISOs/backups) s'ouvre sur son graphe Occupation. i18n `storage.volumes.*` (capacityLower, vgCapacity, committed, lunNote,
  vgChildren, collapse, expand…) + `storage.childOf`.

### Vérifications effectuées
- `pnpm --filter @proxmox/shared build` → `pnpm typecheck` → `pnpm -r test` (**259 shared** dont
  15 `storage-volumes` + 16 `prox4u-client`, **136 server** verts) → `pnpm build` → `./server.sh restart` : OK.
- **Cluster réel (8080)** : `/storage?view=clusterproxmox` → panneau : LUN `baie-iscsi` (Thick,
  « Capacité (borne basse) » 300/300 Go, note « LUN peut être plus grand », Usage 100 %, « 1 VG :
  Lun-iscsi ») + VG enfant `Lun-iscsi` (Capacité du VG 40/300 Go, Usage 13 %). Table : LUN
  `baie-iscsi` (100 % 300/300 Go) dépliable → VG `Lun-iscsi · sous baie-iscsi` (13,3 % 40/300 Go)
  indenté. **Zéro erreur console.**
- **KPIs clusterproxmox** : `storageTotalBytes` = **310,5 GB** (LUN 300 + local 6,2 + local-lvm 4,4 —
  le VG **n'est plus compté en double**) · `storageUsedBytes` = 304,6 GB · `diskThin` = 0 → ratio
  disk **n/a** (pas de faux 916 %).
- **Mock (8095)** : volumes autonomes (ceph rbd sur-allocation, local dir usage/na), aucun iSCSI →
  aucune régression. **Zéro erreur console.**

### Pièges corrigés
- **Double-comptage inversé** : l'ancienne version comptait le VG et écartait le LUN. La bonne
  référence physique est le **LUN** : on le compte, on écarte ses VG enfants (valeur de `duplicateOf`).
  Ne pas réintroduire ni le dédoublonnage à l'envers, ni une heuristique de taille.
- **VG privés de graphique** : l'inversion excluait aussi les VG des séries `datastore_metrics`
  (écrites depuis la liste dédoublonnée) → « Aucun historique » sur le VG, alors que c'est la vue
  où sont les disques. Corrigé : `writeInflux` reçoit **toutes les vues à capacité connue** (VG
  compris) ; le dédoublonnage ne s'applique qu'aux **sommes** KPI. Vérifié : `Lun-iscsi` a de
  nouveau sa série (40/300 Go = 13 %, tendance stable), 0 erreur console.
- **`local` sans VM sans graphe** : la condition `expandable` de la table ne tenait compte que des
  VMs et des VG enfants — un datastore « local » (dir ISOs/backups, **0 VM**) n'était pas
  dépliable, donc son graphe Occupation était inaccessible alors que l'API a 365 points. Corrigé :
  `expandable` inclut désormais la **capacité connue** (`hasCapacity`) — même règle sur les lignes
  enfants (VG sans VM). Vérifié : les 2 `local` (endpoints clusterproxmox + proxmox) s'ouvrent sur
  leur graphe (75 % et 15 %) + Capacity planning, « Aucune VM stockée sur ce datastore », 0 erreur console.
- **LUN « 100 % » trompeur** : sans taille connue, engagé = Σ VG = capacité affichée → ratio 100 %
  (crit). C'est la **borne basse honnête** — le panneau le signale (« LUN peut être plus grand ») ;
  renseigner `lunSizes` donne le vrai ratio.

---

## ✅ Fait — Historique des valeurs des capteurs ET des disques SMART (icône graphique + fenêtre)

Demande utilisateur : dans « Capteurs nœuds — métriques locales Telegraf », une **icône graphique
à côté des températures** qui ouvre une **nouvelle fenêtre** avec l'historique de valeur — d'abord
pour la table « Capteurs » (commit `792c449`), puis « **idem pour Santé disques (SMART)** ».
Rappel utilisateur : l'environnement de test vient d'être ouvert → **des trous dans les métriques
sont attendus** (nœuds éteints) — le graphe les montre tels quels, jamais comblés.

### Correction
- **`GET /api/node-sensors-history?node=&chip=&feature=&range=month|year`** (`modules/nodesensors/
  routes.ts`, `registerSensorHistoryRoute`) : série de température d'UN capteur. Pattern du
  `/api/storage-datastore-history` : **double source** — `raw` (rétention 31 j, points 10 s)
  bucketé en **10 min** + `consolidated` (rétention ∞, buckets 15 min du consolidateur) ; fusion
  dédoublonnée (le raw prime à `t` égal) ; **cache 5 min** par `node/chip/feature:range`.
  Identité requise (400 via `reply.code(400).send` — piège Fastify 5 : `return { statusCode }` ne
  set pas le code) + échappement SQL `sqlStr` (query string). `range` : `month` (31 j, défaut) /
  `year` (1 an). ~2900 pts / 31 j, ~8900 / 1 an (jamais les ~270k points 10 s bruts).
- **`SensorHistoryResponse`** (shared) : `points[{time,temp}]` **sparse** (les trous = données),
  `threshold` (seuil effectif perso ≤ firmware), `thresholdCustom`, `thresholdFirmware` (2ᵉ ligne
  du graphe si perso), `source`. Capteur sans `temp_crit` (ex. `tctl`) → `threshold: null`.
- **`GET /api/smart-device-history?node=&device=&range=month|year`** (`registerSmartHistoryRoute`) :
  même pattern pour un DISQUE (table `smart_device`, colonne `temp_c`) — la logique de fusion est
  extraite dans le helper partagé `mergedTempBuckets(ctx, table, where, window, tempField, keep)`.
  **Sans seuil** (les disques n'ont pas de `temp_crit`) → `SmartHistoryResponse { node, device,
  range, points, source }`. **0 °C exclus** (prédicat `keep(t) => t > 0` — 0 = pas de sonde, cf.
  `smartTempDisplay`) : un disque sans capteur ne doit pas tracer une ligne plate à 0 °C.
  400 `bad-device` si `node`/`device` absent.
- **Web** : icône `Activity` à côté de chaque température de la table « Capteurs » **ET** de la
  table « Santé disques (SMART) » (SMART : seulement s'il y a une lecture — 0 °C = pas de sonde) →
  `HistoryDialog` (refonte `SensorHistoryDialog` → `components/history-dialog.tsx`, **générique** :
  `HistoryTarget = { kind:'sensor'; sensor } | { kind:'smart'; device }`, fetch normalisé
  `fetchSensorHistory` / `fetchSmartHistory`, `markLine` — capteur : seuil effectif rouge +
  firmware gris si perso, SMART : ligne critique fixe **80 °C** (clé
  `nodeSensors.history.smartThreshold`) ; modal `components/ui/dialog.tsx` léger zéro-dépendance :
  overlay, X/Échap, scroll gelé) — identité, dernière mesure, toggle **31 j / 1 an** (style range
  stockage), graphe ECharts (couleur thème `ct.temp`, `connectNulls: false` → **les trous restent
  visibles**, note explicative des trous), états loading/erreur/vide. i18n `nodeSensors.history.*`
  + `nodeSensors.range.*` (fr/en, état vide généralisé). `fetchSmartHistory` dans l'apiClient.

### Vérifications effectuées
- `pnpm --filter @prox4u/shared build` → typecheck (shared/server/web) → tests (**143 server** dont
  4 `registerSensorHistoryRoute` + 3 `registerSmartHistoryRoute` : merge raw/consolidé, seuil
  perso, **exclusion 0 °C**, 400, empty ; **259 shared** verts) → `pnpm build` → `./server.sh
  restart` : OK.
- **API réelle** : capteurs inchangés — `k10temp-pci-00c3/tctl` (nœud `proxmox`) → 128 points sur
  7 jours, **~15 h de mesures réelles sur 7 j = les trous annoncés** (nœud de test éteint), série
  sparse non comblée, `threshold: null` (sans `temp_crit`). SMART : `nvme0n1` (proxmox) →
  **129 points** sur 31 j et 1 an (environnement jeune — données des derniers jours, trous réels),
  valeurs 29–37 °C, `source: influx` ; 400 `bad-device` sans `device`.
- **Navigateur** (fresh) : 17 icônes dans la table Capteurs + **3 dans SMART** (les 4 autres
  disques n'ont pas de sonde → « — », pas d'icône) ; clic icône SMART → fenêtre
  `proxmox/nvme0n1` (dernière mesure 37 °C, canvas ECharts, **1 seule requête** par période) ;
  switch « 1 an » → 2ᵉ requête + rendu ; Échap → fermeture ; icône capteur (régression) →
  fenêtre + graphe. **0 erreur console.**

### Pièges corrigés
- **Fastify 5 — `return { statusCode: 400 }` ≠ HTTP 400** : renvoyé dans le body, status 200.
  `reply.code(400).send(…)` (convention du codebase). Test + vérification live.
- **`chartTheme()` dans les deps d'un effet = boucle de re-fetch infinie** : la fonction renvoie
  un objet **nouveau** à chaque appel — dépendre de l'objet `ct` (plutôt que de `theme`, string
  stable) relance l'effet à chaque rendu (≈200 requêtes observées, fenêtre bloquée « loading »).
  Fix : deps `[target, range, t, theme]` (documenté dans le skill `node-sensors`).
- **~270k points par graphe** : les points Telegraf (10 s) bucketés en 10 min côté requête
  (`date_bin`) — jamais de série brute au navigateur (270k pts / 31 j / capteur).
- **Trous ≠ bug** : environnement de test jeune, nœuds éteints → la série est sparse ;
  `connectNulls: false` et **aucune interpolation** (anticiper du vrai matériel).

---

## ⏳ À faire

### Monitoring — référence ProxMenux + Telegraf (2026-11-04)
TODO priorisée dans **`MONITORING-ACTIONS.md`** (racine) ; analyse complète dans la skill
**`skills/monitoring-proxmenux`**. **P0 livré** : Telegraf bare-metal sur les 3 nœuds Proxmox +
plugin **`node-sensors` v1** (section « Fait » ci-dessus). Reste en P0 : **règles d'alarme**
(SMART critique, température > seuil effectif, unité échouée) dans `centreonnsca`. P1 quorum (donnée déjà pollée) ·
P2 moteur d'alarmes v2 (hystérésis/suppression/ack) · P3 audit best-practices · P4 PBS +
événements · P5 certificats + NTP.

### En attente de décision utilisateur
- [x] **Commit** : **fait le 2026-11-10** — commit `a492724` sur `master` (tout le travail accumulé : livraisons 2026-10-30, capteurs, seuils tri-state SMART, dédoublonnage iSCSI/LVM, cartographie, hiérarchie iSCSI → LVM, graphiques VG + `local`). L'ancienne consigne « pas encore de GIT » (branche `refactor/plugin-architecture`) est caduque : le repo vit désormais sur `master` (auto-backups + commits explicites). Les dossiers de référence `ProxMenux/` et `project-pegaprox/` ont été sortis du repo le 2026-10-24 (→ `/home/opencode/projet/`).
- [ ] **`docker-compose.yml`** (influxdb + explorer, tracké) : dev local uniquement vs retrait du repo
- [x] **Push** : **fait le 2026-11-10** — `master` poussé sur **`https://gitea.priv/prox4u/prox4u.git`** (remote `origin`, token intégré à l'URL ; l'ancien « Push GitHub » est remplacé par ce remote Gitea privé). Local et remote synchrones à `a492724`.
- [x] **Fusion dans main** : caduque — le travail est **directement sur `master`** (branche de travail = branche remote), plus de branche `refactor/plugin-architecture` à fusionner.

### Prochain jalon — Suite de la Phase 1B (stockage, backups PBS, alarmes)
La topologie réseau **et la vue stockage** sont **livrées** (sections « Fait » ci-dessus). Il reste en 1B :
- [ ] **Stockage 2ᵉ temps** : **panneau Ceph auto** (HEALTH, grille OSDs, PGs) + **graphes I/O lecture/écriture** (la table vCenter + drill-down + recherche + export sont livrés, voir section « Fait »)
- [ ] **Backups PBS** : KPI couverture backup (< 7 j), tableau par VM, capacité datastores PBS — nécessite token API PBS dans `.env` (mode mock PBS à prévoir)
- [ ] **Disponibilité & événements** : sonde active 30 s par nœud, quorum/uptime, moteur d'alarmes (hystérésis OK→WARN→CRIT), feed d'événements

### Idées pour la suite (à valider)
- Projection du risque (« surallocation dangereuse dans ~X jours » à la croissance actuelle), top VMs contribuant à la demande pire cas, alerte au changement de niveau de risque (🟢→🟠→🔴), détail de la surallocation par nœud

### Phase 1 — finitions / points de vigilance
- [x] **Refonte UI** (dark mode natif + drag & drop des blocs + restyle shadcn/ui) : livrée — thème sombre + accents personnalisables, restyle design system, drag & drop + resize sur `/` et `/e/:id` (voir section « Fait » ci-dessus) ; plan d'origine dans [`PLAN-refonte-ui.md`](./PLAN-refonte-ui.md)
- [~] **PRA multi-bâtiment réel** : validé en mock (3 scénarios) + **simulation 2 sites activée dans `sites.json`** (`ProxSite1` / `ProxSite2`, endpoint `clusterproxmox`) → PRA N-1 calculé sur le vrai cluster (absorption 100 % 🟠 si ProxSite1 tombe, 1 VM affectée) — à affiner quand la topologie réelle des bâtiments sera connue
- [~] **Capacity planning** : pipeline validé le 2026-10-08 — `/api/capacity` lit InfluxDB (`source: influx`), historique quotidien cohérent avec `consolidated`, prévision correctement en attente (`insufficientData: true`, 2-3 j d'historique seulement car app arrêtée du 3 au 7 oct) — la justesse des courbes se confirmera à l'accumulation (30 j)
- [x] **Consolidated** : validé le 2026-10-08 — le timeframe `month` lit bien `consolidated` en continu (`source: influx`, points quotidiens pour chaque jour ayant des données ; les jours vides = app arrêtée, pas un défaut du pipeline) · consolidateur à jour (état `lastTs` = maintenant)

### Phase 1B — Supervision & vues graphiques (jalon suivant)
Périmètre (détail dans le skill §4B) :
- [x] **Topologie réseau** React Flow (`@xyflow/react`) : switches → nœuds → bridges → [segments VLAN] → VMs, liens ∝ débit réel, clic → détail, filtre multi-sélection, analyse d'impact incident, **mode simulation PRA**, nœuds déplaçables, libellés d'interface collés aux VMs — **livrée** (section « Fait » ci-dessus) ; `network.json` restant optionnel
- [x] **Vue stockage** type vCenter : table de datastores + **barre de capacité colorée** + icône de type + nœud/partagé + **drill-down des VMs** + recherche + déroulé de type + vue agrégée + deep-link + export CSV — **livrée** (section « Fait » ci-dessus) ; **panneau Ceph auto** (HEALTH, grille OSDs, PGs) + graphes I/O lecture/écriture = 2ᵉ temps
- [ ] **Backups PBS** : KPI couverture backup (< 7 j), tableau par VM, capacité datastores PBS — nécessite token API PBS dans `.env`
- [ ] **Disponibilité & événements** : sonde active 30 s par nœud, quorum/uptime, **moteur d'alarmes** (hystérésis OK→WARN→CRIT), feed d'événements (tâches + changements détectés)
- [~] **Page détail nœud** : *KPIs + historique CPU/RAM/réseau + VMs hébergées déjà livrés* (route `/e/:endpointId/n/:nodeId`, sidebar) — reste : interfaces réseau (up/down, vitesse), tâches en cours
- Ajouts techniques : dépendance `@xyflow/react`, poller étendu (débits = delta compteurs + ring buffer 1 h), `modules/supervision/` côté serveur

### Phases suivantes (roadmap)
| Phase | Contenu |
|---|---|
| 2 | Inventaire + page détail VM (graphes live + historique) — **inventaire, détail plein écran, onglet Monitor (historique CPU/RAM InfluxDB + export CSV) et détail nœud Proxmox (Résumé/Monitor/VMs) livrés** (sections « Fait » ci-dessus) |
| 3 | Opérations : start/stop/reboot/migrate/snapshot + journal d'audit |
| 4 | Wizard de déploiement depuis templates (clone) |
| 5 | Storage/réseau avancés, rapports PDF/CSV, moteur d'alarmes custom (seuils) |

### Prérequis utilisateur encore attendus
- [ ] (1B) Token API PBS + URL du serveur PBS → `.env` — **pas de serveur PBS dans l'infra pour l'instant** (confirmé utilisateur, 2026-10-08) : le module Backups attend le déploiement PBS ; prévoir un **mode mock PBS** (comme le mock Proxmox) pour développer/démontrer le module sans serveur réel
- [ ] (1B) Schéma de câblage switches/liens → `network.json`
- [ ] (Phase 1) Mapping nœuds → bâtiments complet dans `sites.json` si le cluster multi-sites est en place

---

## Fichiers clés
```
up.sh                         # démarrage complet : InfluxDB (Docker) + application
server.sh                     # start/stop/restart/status de l'app seule (healthcheck TLS-aware)
docker-compose.yml            # InfluxDB 3 Core (8181 HTTPS, user non-root, secret token)
deploiement/                  # LIVRABLE de déploiement autonome (dans le tarball) : DEPLOY.md + scripts numérotés 10-proxmox-token.sh (PVE), 20-package-release.sh (dev), 30-env-setup.sh (.env), 40-tls-init.sh (certs, clés 644), 50-influxdb-init.sh (token admin) + prox4u.service
data/                         # tls/, influxdb/ + explorer/ (chown 1500:1500), consolidation-state.json
.env / sites.json             # config cluster (repli mono-endpoint) + topologie sites (champ endpoint)
clusters.json                 # endpoints Proxmox multi-cluster (600, gitignored) — template : clusters.example.json
overcommit.json               # politique de surallocation + seuils d'usage (hot-reload, source unique du code couleur)
packages/shared/src/          # types (MultiDashboardSnapshot…), health.ts, pra.ts, capacity.ts, overcommit.ts, network.ts (builder topologie pur, 22 tests), storage-inventory.ts (vue stockage vCenter, 18 tests), storage-volumes.ts (cartographie iSCSI → LVM en arbre, 15 tests), vm-inventory.ts (filtre/tri/tree inventaire VM, 15 tests), i18n/ (+ 8 suites de tests)
packages/server/src/core/     # config (clusters.json + overcommit.json hot-reload), proxmox-client (getNetwork, getStorage, diskStorageOf — parse du datastore du disque VM), mock-source, poller multi-endpoints, influx, influx-consolidator, ws-hub
packages/server/src/modules/dashboard/routes.ts   # /api/* (?endpoint=, InfluxDB d'abord, repli RRD + "source")
packages/server/src/modules/supervision/routes.ts # /api/network-topology + /api/storage-inventory (cache 5 min) + /api/storage-datastore-history (séries d'occupation par datastore + prévision, datastore_metrics InfluxDB / repli RRD)
packages/server/src/modules/vminventory/routes.ts # /api/vm-config (live + config cache 1 h + snapshots à la demande, cache 5 min) + /api/vm-metrics (historique VM InfluxDB, cache 5 min)
packages/server/src/modules/nodesensors/routes.ts # /api/node-sensors (métriques locales Telegraf : SMART, capteurs, ZFS ARC, unités systemd — cache 1 min, base raw)
packages/server/src/modules/auth/     # store (data/auth.json) + routes (login/me/logout/preferences/admin) + guard API & WS
packages/server/src/index.ts  # entry Fastify HTTPS + SPA + WS (buildEndpoints, fallback default)
packages/web/src/app.tsx      # router host : routes des plugins actifs + layout shell (ModuleDisabled si flag OFF)
packages/web/src/core/plugin/ # contrat (types zod, registry, loader, eventBus, logger) + core/config/features.ts (flags VITE_USE_PLUGIN_*)
packages/web/src/components/layout/           # sidebar (PluginMenu — l'arbre endpoints/nœuds Proxmox est un sous-menu repliable sous « Vue d'ensemble », plus de section PROXMOX), topbar (santé globale)
packages/web/src/plugins/hypervision/         # index.tsx (submenu + statusDot) + pages overview/endpoint/node (titres de page) + proxmox-nav-tree.tsx (sous-menu sidebar + pastille agrégée) + composants (menu order 10)
packages/web/src/plugins/network/             # topology.tsx + topology-flow (React Flow : layout pur, filtre, impact, PRA, drag, IfaceEdge), network-inventory, multi-select (menu order 20)
packages/web/src/plugins/storage/             # storage.tsx + storage-inventory (table vCenter : barre de capacité colorée, hiérarchie iSCSI → LVM, drill-down graphe Occupation + VMs, recherche, export CSV) + storage-volumes (panneau « Volumes physiques » en arbre repliable) (menu order 30)
packages/web/src/plugins/vm-inventory/        # vm-inventory.tsx + vm-tree (Datacenter→cluster→nœud), vm-table (filtres/tri), vm-detail (onglets Config/Réseau/Snapshots) (menu order 40)
packages/web/src/plugins/vm-inventory_v2/     # approche vCenter : arbre avec feuilles VM + détail plein écran (onglets, grille Résumé style vSphere) + bouton « Console web (UI PVE) » + colonne « Agent PVE » (version canonique = la plus récente)
packages/web/src/plugins/proxmox-inventory/   # inventaire consolidé multi-endpoints (une machine par ligne QEMU+LXC) : OS réel (agent), disques par fs, interfaces/IPs, tags, état agent PVE, filtres par colonne + export TXT/CSV/JSON (menu order 50)
packages/web/src/components/auth/             # login-form, protected-route (ProtectedRoute+ModuleRoute), change-password-form, module-selector (une case par version)
packages/web/src/components/admin/            # module-catalog (une carte par version, sans activation), group-manager, user-manager
packages/web/src/pages/{login,profile,admin}/ # auth + admin (3 onglets : catalogue / groupes / utilisateurs)
data/auth.json                                # users/groups/modules/préférences (600, gitignored — comptes migrés de l'ancienne app)
packages/web/src/hooks/use-echart.ts              # wrapper ECharts (init paresseux)
packages/web/src/index.css                        # Tailwind v4 + tokens Tremor + @source inline
skills/                                           # base de connaissance (trackée, livrée en prod) : 12 SKILL.md + README.md (inventaire) — .opencode/skills/ = symlinks locaux
```
