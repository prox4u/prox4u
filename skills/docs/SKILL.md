---
name: docs
description: Base de connaissance du plugin Documentation de Prox4u — module in-app « Documentation » (routes /docs + /docs/:moduleId, menu BookOpen order 90) : notices d'utilisation par module en Markdown (source .md dans le repo, bundlées au build via `?raw`), rendues en HTML par `marked` (GFM). Une notice par famille de plugin (9 modules : hypervision, network, storage, vm-view, proxmox-inventory, centreon-nsca, node-sensors, audit, influxdb). Accès par module (pas d'accès au plugin = pas accès à sa doc, même source visibleModuleIds que ModuleRoute), le module `docs` lui-même géré par le catalogue (globallyEnabled — visible par tous les users connectés, migration reconcileModules). Bibliothèque de screenshots packages/web/public/screenshots/ (28 images, servies à /screenshots/…). Structure type d'une notice (6 sections) + règles de rédaction. Use when working on the docs plugin (packages/web/src/plugins/docs/), the /docs page, adding or editing a notice (content/*.md), the screenshot library, or the docs access control / migration.
---

# Documentation — Base de connaissance

> 📖 **C'est le module lui-même** : les notices utilisateur vivent dans ce plugin (`content/*.md`) et s'affichent dans l'app à `/docs` (menu « Documentation »).

Module in-app de **documentation utilisateur** : une **notice d'utilisation par module** (famille de plugin), rédigée en **Markdown** dans le repo et rendue en **HTML** dans l'app. Contenu **FR** (v1) ; l'EN viendra ensuite.

> Architecture globale (plugin host/loader/registry) : voir le skill `general`.

## 1. Manifest (`index.ts`)
- id `docs`, version 1.0.0. Routes : `/docs` + `/docs/:moduleId` → `DocsPage`. Menu `nav.docs` (icône `BookOpen`), **order 90** (dernière entrée du menu). `init()` : log uniquement.
- **Feature flag** : `VITE_USE_PLUGIN_DOCS` — les routes `/docs` + `/docs/:moduleId` sont enveloppées de `<ModuleDisabled module="docs" flag="VITE_USE_PLUGIN_DOCS" />` dans `app.tsx` (comme les autres plugins).

## 2. Arborescence
| Fichier | Rôle |
|---|---|
| `index.ts` | Manifest du plugin (routes + menu). |
| `pages/docs.tsx` | La page : catalogue `DOC_MODULES` (9 entrées), sidebar des modules accessibles, rendu de la notice active. |
| `lib/markdown.tsx` | `renderMarkdown(md)` — rendu Markdown → HTML via `marked` (GFM : tableaux, listes, code). `marked.setOptions({ gfm: true, breaks: false })`. |
| `docs.css` | Styles de la prose (`.docs-prose`) : titres, tableaux, code, images, listes. |
| `content/*.md` | **Les 9 notices** (source de vérité du contenu, dans le repo). |

## 3. Catalogue des notices (`DOC_MODULES` dans `docs.tsx`)
Tableau de 9 entrées `{ id, labelKey, icon, content }`. `content` = le Markdown importé via **`?raw`** (bundlé au build) ou `null` (→ état « à venir »). **Toutes les 9 sont rédigées** (v1) :

| id | Notice (H1) | Route module | Source | Lignes | Img |
|---|---|---|---|---|---|
| `hypervision` | Vue d'ensemble | `/` | `content/hypervision.md` | 137 | 5 |
| `network` | Topologie réseau | `/topology` | `content/network.md` | 124 | 1 |
| `storage` | Stockage | `/storage` | `content/storage.md` | 103 | 1 |
| `vm-view` | Vue VM | `/vms` | `content/vm-view.md` | 119 | 3 |
| `proxmox-inventory` | Inventaire Proxmox | `/proxmox-inventory` | `content/proxmox-inventory.md` | 96 | 1 |
| `centreon-nsca` | Alarmes & Centreon | `/alarms` | `content/centreon-nsca.md` | 109 | 3 |
| `node-sensors` | Capteurs nœuds | `/node-sensors` | `content/node-sensors.md` | 118 | 1 |
| `audit` | Audit / best-practices | `/audit` | `content/audit.md` | 109 | 1 |
| `influxdb` | InfluxDB 3 Core | `/influxdb` | `content/influxdb.md` | 122 | 1 |

- `labelKey` = la clé i18n du **menu du module concerné** (`nav.overview`, `nav.topology`, …) — la sidebar réutilise le libellé du menu, pas un libellé dédié.
- `icon` = l'icône lucide du module (réutilisée).
- **Total** : 1037 lignes de Markdown, 17 screenshots référencés (tous présents dans `public/screenshots/`).

## 4. Accès par module (règle clé)
- La sidebar ne liste que les modules de **`visibleModuleIds`** (autorisé ∩ préférences user) — **même source que `ModuleRoute`** : un user **sans accès à un plugin n'a pas accès à sa doc**.
- Accès direct `/docs/<module>` sans permission → `<Navigate to="/profile" replace />` (comme ModuleRoute).
- URL explicite vers un id inconnu → repli `/docs`.
- Aucun module visible → message `docs.noAccess`.
- Le module `docs` **lui-même** est géré par le **catalogue** (catalogue global + groupes) : l'admin peut masquer toute la documentation à un groupe. `docs` est dans `DEFAULT_MODULES` avec **`globallyEnabled: true`** (visible par tous les users connectés).

## 5. Migration (serveur) — `reconcileModules` (`auth/store.ts`)
- Un module **global** (`globallyEnabled: true`) nouvellement ajouté au catalogue est **ajouté aux préférences de TOUS les users** (pas seulement les nouveaux) — un module global est sélectionné par défaut. C'est ce qui fait que `docs` est visible par tous les users existants sans action admin.
- Testée (tests store).

## 6. Bibliothèque de screenshots
- **`packages/web/public/screenshots/`** — 28 images PNG, **servies à `/screenshots/…`** (fastify-static, copiées dans `dist/` au build).
- Dupliquées depuis **`docs/screenshots/`** (source dans le repo, référencées par le README).
- Les notices référencent les images par **URL absolue** : `![légende](/screenshots/<fichier>.png)`.
- Captures **1920×1080** (viewport Playwright) pour la cohérence.
- Pour ajouter un screenshot : l'ajouter dans `public/screenshots/` **+** `docs/screenshots/` (les deux), puis le référencer dans la notice.

## 7. Structure type d'une notice (modèle `centreon-nsca.md`)
Toute notice suit cette structure (6 sections) :
```
# <Nom du module>

<1-2 phrases : ce que fait le module>

- **Qui s'en sert** : <qui — DSI/admin/NOC>
- **Ce que ça fait** : <résumé>

---

## Comment s'en servir
### 1. <étape>            ← étapes numérotées, termes d'UI en **gras**, screenshots si pertinent
### 2. <étape>

---

## Ce qui se passe en fond   ← fréquences, flux de données ; tableau (Événement | Quand | Détail) si périodique

---

## Configuration (récap)     ← tableau (Paramètre | Où | Défaut)

---

## Limites connues           ← puces

---

## FAQ / dépannage           ← **question** ? + réponse
```

## 8. Règles de rédaction
- **Français**, langage utilisateur (DSI/admin/NOC) — pas de jargon code sauf termes techniques en `` `code` ``.
- Termes d'UI en **gras** (libellés français exacts du i18n), termes techniques en `` `code` ``.
- **Fidèle à la skill du module** (source de vérité) — ne pas inventer de fonctionnalités ni de fréquences.
- ~80-150 lignes. Pas de blocs de code sauf si vraiment utile.
- Screenshots : uniquement ceux qui existent et sont pertinents, référencés `![légende](/screenshots/<fichier>.png)`.
- **Référence croisée** : chaque skill de module pointe vers sa notice (ligne `> 📖 **Notice utilisateur** : …` après le H1 de la skill) — maintenir cette réciproque quand on ajoute/modifie une notice.

## 9. i18n
Clés dans `packages/shared/src/i18n/fr.ts` + `en.ts` : `nav.docs` (menu), `docs.title`, `docs.subtitle`, `docs.comingSoon`, `docs.noAccess`, `docs.noAccessModule`.

## 10. Décisions & pièges
- **`?raw`** : le Markdown est **bundlé au build** (pas de fetch runtime) — un changement de notice exige un **rebuild web** (`pnpm --filter @prox4u/web build`). Pas de restart serveur (fastify-static sert `dist/`).
- **Contenu de confiance** : les notices sont du Markdown statique dans le repo → `dangerouslySetInnerHTML` sans sanitization externe (pas de XSS externe). Ne pas accepter de Markdown utilisateur.
- **Landing par défaut** : `/docs` tombe sur la **1ʳᵉ notice rédigée accessible** (repli : 1ᵉʳ module accessible) — depuis la v1, c'est `hypervision` (1ʳᵉ du catalogue).
- **`labelKey` réutilise le menu** : la sidebar affiche le libellé du menu du module (`nav.*`), pas un libellé dédié — si le libellé du menu change, la sidebar doc suit.
- **EN à venir** : le contenu des notices est FR (v1) ; la structure i18n existe déjà pour les libellés de chrome (title/subtitle/comingSoon/noAccess).
- **Module global** : `docs` est `globallyEnabled` — la migration `reconcileModules` l'ajoute aux préférences de tous les users ; ne pas le retirer du catalogue sans prévoir la migration inverse.
