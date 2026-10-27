# Prox4u — Bases de connaissance (skills)

Ce dossier est la **base de connaissance** du projet : une source unique de vérité, trackée par git et livrée avec l'application en production. Elle est conçue pour permettre la **reprise du travail** par un humain ou une IA, sans re-découverte du code.

## 1. Objectif du projet

**Prox4u** est un **logiciel modulaire type vCenter, mais pour Proxmox VE** : hypervision du parc destinée aux managers/DSI — KPIs, Health Score, PRA N-1, capacity planning, surallocation (overcommit), topologie réseau, inventaire stockage.

Principes directeurs :
- **Modularité par plugins** : le host est minimal (routing, menu, données WS, design system) ; tout le métier vit dans des plugins auto-contenus (`packages/web/src/plugins/`). Ajouter un module = ajouter un plugin, sans toucher au cœur.
- **Multi-endpoints** : une seule application supervise plusieurs clusters/endpoints Proxmox.
- **UI type vCenter** : impact visuel, synthèse, code couleur — zéro log « ingénieur » à l'écran d'accueil.

## 2. Rôle des nœuds Proxmox (environnement de test)

Les nœuds Proxmox actuellement branchés servent **uniquement à tester l'API PVE et la collecte des métriques** (via InfluxDB). Ils ne représentent pas le parc de production :

- Chaîne de données réelle : API PVE → poller (tick 5 s) → **InfluxDB (service externe en prod)** → API REST + WebSocket → web.
- L'application est dimensionnée pour l'**échelle cible** ci-dessous (§3), pas pour le cluster de test.
- En production, l'app pointe sur l'InfluxDB existant via `INFLUX_URL` dans `.env` — InfluxDB n'est **pas** déployé avec l'app.

## 3. Échelle cible (estimation)

Ordres de grandeur à prévoir : **~500 VMs et ~200 VLANs**. C'est une estimation, à confirmer sur les données réelles.

| Élément | Estimation | Impact sur le design |
|---|---|---|
| VMs (~500) | snapshot WS `vms[]` ≈ 50–75 Ko/endpoint/push (toutes les 5 s) | Acceptable en LAN ; surveiller si le nombre d'endpoints croît |
| VMs running (~70 %) | mesure `vm_metrics` ≈ 4 200 lignes/min ≈ 6 M lignes/jour | Sans problème pour InfluxDB 3 Core |
| VLANs (~200) | **écran le plus lourd** : topologie jusqu'à ~800–1 000 nœuds React Flow par endpoint (segments + VMs + ponts + nœuds) | Filtres obligatoires (priorité : réseau > recherche > multi-sélection), pas de graphe en vue agrégée, layout déterministe, « Réinitialiser le layout » |
| Datastores | peu nombreux ; drill-down paginé (50 VMs/page) | Pas de risque identifié |
| Historique 7 j | ~11 500 points/série/jour (tick 5 s) | Requêtes SQL InfluxDB par bucket — OK |

Si l'échelle augmente nettement au-delà, les points à surveiller en premier : **taille du payload WS**, **rendu de la topologie**, **volume d'écriture InfluxDB**.

## 4. Structure et emplacement des skills

### 4.1 Où elles vivent
- **`skills/<module>/SKILL.md`** (racine du repo) — **source unique de vérité**, trackée par git, livrée en production avec l'app.
- **`.opencode/skills/`** — **symlinks uniquement** → `../../skills/*`, pour l'auto-découverte par OpenCode. Ce dossier est gitignoré (outils d'agent locaux) : n'y jamais mettre de contenu réel, sinon il serait perdu au push/clonage.

### 4.2 Inventaire
| Skill | Périmètre |
|---|---|
| `general` | Architecture globale : contrat plugin, monorepo, flux de données (poller/InfluxDB/API/WS), design system, i18n, overcommit, déploiement, pièges transverses |
| `hypervision` | Plugin hypervision : `/`, `/e/:endpointId`, `/e/:endpointId/n/:nodeId` + 12 composants (KPIs, graphiques 7 j, PRA, capacity, surallocation) |
| `network` | Plugin network : `/topology` — graphe React Flow, inventaire réseaux→VMs, analyse d'impact incident, simulation PRA N-1 |
| `storage` | Plugin storage : `/storage` — table vCenter des datastores, drill-down VMs, export CSV |
| `vm-inventory` | Plugin inventaire VM : `/vms` — tree vCenter (Datacenter→cluster→nœud), tableau multi-endpoints live, détail à onglets (Config/Réseau/Snapshots) via `/api/vm-config` |
| `operations` | Runbook production : kit de déploiement `deploiement/`, pointage InfluxDB externe, systemd/server.sh, day-2, dépannage (WS, repli RRD, TLS SAN, tokens PVE) |
| `shared` | Package `@proxmox/shared` : fonctions pures testées par fichier, types partagés, THRESHOLDS, i18n fr/en |
| `api` | Contrat API REST + WebSocket `/ws` : endpoints, formes de réponse, caches 5 min, repli InfluxDB→RRD |

### 4.3 Format d'une skill
- Frontmatter YAML : `name` (id stable) + `description` (périmètre + trigger « Use when… » pour l'auto-découverte IA).
- Sections numérotées (§) — les autres documents peuvent y référer (« voir skill `network` §4 »).
- Contenu = base de connaissance de reprise : rôle, arborescence du code, données (endpoints API + mesures InfluxDB), composants, **décisions actées**, pièges.

### 4.4 Règles de maintenance
1. **Modifier un module → mettre à jour sa skill dans le même commit** (décisions, pièges, nouveaux fichiers).
2. **Nouveau plugin** → nouvelle `skills/<id>/SKILL.md` + symlink `.opencode/skills/<id>` + ligne dans l'inventaire (§4.2).
3. **Décision transverse** (architecture, déploiement, stack) → skill `general`.
4. **Pas de duplication** entre skills : un module = une skill, renvois croisés par nom.

## 5. Phases connues non implémentées (roadmap)
- Panneau Ceph + graphiques I-O (storage, phase 2).
- Backups PBS, alarmes (supervision, roadmap initiale).
- Tout ajout de module suit le workflow « ajouter un plugin » (skill `general` §2.4) + la création de sa skill (§4.4).

> L'état courant du projet (avancée, validations, points en attente) est suivi dans `STATUS.md` à la racine — ce fichier décrit la structure et le contexte, pas l'avancement.
