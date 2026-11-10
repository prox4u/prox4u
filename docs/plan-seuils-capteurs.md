# Plan de travail — Seuils capteurs personnalisés

## Contexte
Le module `node-sensors` v1 affiche les températures avec le seuil critique venant du
firmware (ex. 110°C GPU, 108°C mémoire). L'utilisateur souhaite pouvoir **abaisser**
ce seuil pour alermer plus tôt, sans jamais le monter au-dessus de la valeur matériel.

## Consignes (non négociables)
1. **Conserver la valeur firmware** comme référence permanente (affichage + fallback)
2. **Baisser uniquement** : seuil perso ≤ seuil firmware (clamp à la saisie)
3. **Persistance** : `data/sensor-thresholds.json` (même pattern que `centreon-nsca.json`)
4. **Page Administration** : nouvel onglet « Seuils capteurs » (à côté de Centreon NSCA)
5. **Pas de modification Telegraf** : le capteur reste en lecture seule côté agent

## Structure de données
```json
{
  "proxmox/amdgpu-pci-2300/mem": 85,
  "proxmox/amdgpu-pci-0300/edge": 90
}
```
Clé = `node/chip/feature`, valeur = seuil en °C (entier ou décimal).
Absence de clé = fallback firmware.

## Tâches

### 1. Backend — endpoint API
- [x] `GET /api/admin/sensor-thresholds` → renvoie les seuils personnalisés + firmware
- [x] `PUT /api/admin/sensor-thresholds` → enregistre/modifie (validation : perso ≤ firmware)
- [x] `DELETE /api/admin/sensor-thresholds/:node/:chip/:feature` → reset (repasse au firmware)
- [x] Stockage `data/sensor-thresholds.json` (tmp+rename, pattern consolidation-state)
- [x] Routeur dans `packages/server/src/modules/nodesensors/routes.ts` (ou nouveau fichier)
- [x] Guard : lecture = tout utilisateur du module, écriture = admin uniquement

### 2. Page Administration — onglet « Seuils capteurs »
- [x] Nouveau composant `packages/web/src/components/admin/sensor-thresholds.tsx`
- [x] Tableau : nœud / puce / capteur / temp actuelle / seuil firmware (RO) / seuil perso (input)
- [x] Input avec `max={firmware}` (impossible de dépasser)
- [x] Bouton reset par ligne (revenir au firmware)
- [x] Bouton « Tout réinitialiser »
- [x] Sauvegarde explicite (bouton « Enregistrer ») ou auto-save sur blur
- [x] Intégration dans la page Administration (onglet à côté de Centreon NSCA)

### 3. Intégration dans le tableau capteurs (node-sensors)
- [x] Le tableau « Capteurs » utilise le seuil perso si présent, sinon le firmware
- [x] Affichage : seuil perso en couleur + firmware en petit/gris à côté
- [x] La couleur de la température (vert/orange/rouge) suit le seuil EFFECTIF (perso ou firmware)
- [x] Type partagé : ajouter `sensorThresholds: Record<string, number>` à `NodeSensorsResponse`
- [x] Le routeur `/api/node-sensors` merge les seuils perso dans la réponse

### 4. Types partagés + i18n
- [x] `packages/shared/src/node-sensors.ts` : ajouter `SensorThreshold` interface
- [x] i18n FR/EN : libellés onglet admin, boutons, validation
- [x] Rebuild shared → web → server

### 5. Tests + validation
- [x] Test manuel : modifier un seuil, vérifier que le tableau capteurs change de couleur
- [x] Test : essayer de mettre un seuil > firmware → clampé
- [x] Test : reset → retour au firmware
- [x] Test : restart serveur → seuils persistés
- [x] Test : utilisateur non-admin → lecture OK, écriture 403

## Fichiers à créer/modifier
| Fichier | Action |
|---------|--------|
| `packages/server/src/modules/nodesensors/thresholds.ts` | NOUVEAU — endpoints CRUD |
| `packages/server/src/modules/nodesensors/routes.ts` | MODIF — merge seuils dans la réponse |
| `packages/shared/src/node-sensors.ts` | MODIF — types seuils |
| `packages/web/src/components/admin/sensor-thresholds.tsx` | NOUVEAU — page admin |
| `packages/web/src/components/admin/index.tsx` (ou page admin) | MODIF — onglet ajouté |
| `packages/web/src/plugins/node-sensors/pages/node-sensors.tsx` | MODIF — affichage seuil effectif |
| `packages/shared/src/i18n/fr.ts` | MODIF — libellés |
| `packages/shared/src/i18n/en.ts` | MODIF — libellés |
| `data/sensor-thresholds.json` | NOUVEAU (auto-créé au 1er enregistrement) |

## Hors périmètre (pour plus tard)
- Seuils SMART (usure NVMe > X%, secteurs reallocated > N) — à discuter
- Règles d'alarme centreonnsca basées sur les seuils perso (P0 suivant)
- Historique des modifications (qui a changé quoi, quand)
