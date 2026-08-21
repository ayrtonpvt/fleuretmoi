# Corrections — 11 août 2026

## Priorité 1 — identification corrigeable
- Une observation peut sélectionner n’importe laquelle des propositions Pl@ntNet.
- Une observation déjà vérifiée peut être réassignée à une autre proposition.
- Ajout d’une identification manuelle (nom scientifique obligatoire ; nom commun, famille et genre facultatifs).
- Une validation peut être annulée ; l’observation sort alors de l’Herbier sans être supprimée.

## Priorité 2 — cohérence Herbier / observations
- `observation.speciesId` est désormais la relation de référence.
- Les anciens `species.observationIds` ne servent plus au rattachement et sont retirés lors de la synchronisation.
- Les dates `firstSeenAt` / `lastSeenAt` sont recalculées après réassignation, suppression ou modification de date.
- Une espèce sans aucune observation vérifiée est supprimée automatiquement.
- Les notes d’observation ne sont plus recopiées automatiquement dans les notes d’espèce.

## Priorité 3 — gestion et sauvegarde des données
- Suppression individuelle d’une observation.
- Correction manuelle de la date et de l’heure d’une observation.
- Export JSON complet des observations, espèces, file hors connexion et photos.
- Import d’une sauvegarde avec remplacement explicite de la base après confirmation.
- La clé API Pl@ntNet n’est pas exportée.
- « Effacer » vide désormais aussi la file hors connexion.

## Priorité 4 — performances et robustesse
- IndexedDB réutilise une connexion au lieu d’en rouvrir une à chaque opération.
- Les écritures attendent la fin de la transaction IndexedDB.
- Les observations d’une espèce utilisent l’index `speciesId`.
- Le rendu de l’Herbier charge les observations une seule fois et les groupe en mémoire, au lieu de relire toute la base pour chaque espèce.
- La carte ne charge plus deux fois toutes les observations.

## Corrections secondaires
- L’Historique n’est plus silencieusement limité aux 60 dernières observations : chargement progressif par blocs de 60.
- Le résumé « Vos captures » d’une espèce affiche maintenant le nombre d’observations et les premières/dernières dates.
- La file hors connexion conserve et affiche la dernière erreur Pl@ntNet et propose « Réessayer ».
- La navigation principale reste visible sur mobile, tout en conservant les gestes de balayage.
- Le cache du service worker passe à `fleuretmoi-pages-v12`.
- README mis à jour pour décrire le comportement offline réel.

## Validation effectuée
- `node --check` sur `app.js` et `sw.js`.
- Vérification des IDs HTML et des sélecteurs utilisés par le JavaScript.
- Vérification de la structure HTML, du manifest JSON et des accolades CSS.
- Tests ciblés sur sélection/correction d’identification, rattachement espèce↔observations, réassignation, suppression d’espèce vide et séparation des notes.
- Test aller-retour de sérialisation des photos pour l’export/import.

- Fiche espèce : suppression du résumé textuel sous « Vos captures » afin d’afficher directement les captures.

## Phase de test — illustrations Wikimedia
- Ajout d'un laboratoire séparé (`illustration-test.html`) qui ne modifie jamais l'Herbier.
- Filtre dur sur la catégorie `<espèce exacte> - botanical illustrations` ; aucun élargissement vers une autre espèce.
- Détection conservatrice des planches également classées dans une autre catégorie d'illustrations d'espèce ; elles passent derrière toutes les illustrations mono-espèce.
- Premier score esthétique explicable : A composition, C couleur, D séparation sujet/fond, E densité parasite, F qualité technique, plus un bonus portrait.
- Le potentiel de recadrage n'est calculé qu'en secours lorsque trop peu d'images mono-espèce dépassent le seuil de qualité plein cadre.
- Les références positives fournies pour Malva sylvestris, Raphanus sativus, Nerium oleander et Narcissus poeticus sont marquées dans le laboratoire afin de mesurer leur présence dans le top 6 et le top 12.
- Les poids et le seuil sont réglables en direct sans modifier les filtres taxonomiques.

## Illustrations Wikimedia intégrées

- Correction du score C : chroma réelle, les scans monochromes/sepia restent bas.
- Déduplication perceptuelle des variantes quasi identiques.
- Sélecteur depuis la fiche espèce : 6 propositions puis pagination par 6.
- Priorité stricte : catégorie de l’espèce exacte -> botanical illustrations -> espèce seule -> classement esthétique -> recadrage secours -> multi-espèces.
- Choix enregistré localement avec source Wikimedia, licence et copie de travail hors ligne.
- Recadrage/zoom/repositionnement non destructif depuis la fiche espèce.


## Passe interface illustration / Herbier

- Le placeholder d’illustration affiche désormais simplement **CHOISIR**.
- La source/licence Wikimedia reste enregistrée dans les données mais n’est plus affichée sous l’illustration.
- Les boutons Recadrer / Changer / Retirer sous l’image ont été supprimés : un clic sur l’illustration ouvre directement l’éditeur.
- L’éditeur contient **Changer d’illustration**, Réinitialiser et un bouton de validation en forme de coche.
- Les modales principales peuvent être fermées en cliquant sur leur arrière-plan.
- La fiche d’identité de l’espèce reprend la couleur de fond dominante de l’illustration, calculée sur ses bords, avec adaptation du contraste du texte.
- Le sélecteur natif de tri de l’Herbier a été remplacé par un bouton/menu CSS dédié.


## v25 — fallback manuel des illustrations
- Le sélecteur Wikimedia propose désormais **Importer une image** et **Rechercher sur Google Images**.
- Si Wikimedia ne trouve aucune illustration fiable, ces actions deviennent le fallback principal.
- Une image importée passe par le même éditeur de cadrage/zoom et est enregistrée localement avec `source: "manual"`.
- La recherche Google Images utilise le nom scientifique exact suivi de `botanical illustration` et n'effectue aucun téléchargement automatique.


## v14 — observations multi-photos
- Ajout visible de photos supplémentaires directement dans la section Photos, jusqu’à 5 pour une même observation.
- Chaque photo conserve son organe Pl@ntNet (fleur, feuille, fruit, écorce/tronc, vue générale/autre).
- La fiche Capture affiche toutes les photos d’une observation avec leur organe associé.


## v17 — taxons hybrides et synonymes
- Normalisation typographique des hybrides (`Rosa x odorata` → `Rosa × odorata`) sans modifier l'identité taxonomique.
- La recherche d'illustrations accepte les variantes `×`, `x` et sans marqueur hybride.
- Résolution Wikidata de la catégorie Commons, du nom taxonomique, des synonymes (P1420) et du basionyme (P566).
- Recherche de fichiers Commons sous les synonymes taxonomiques vérifiés avant le fallback manuel.
- Correction de la détection multi-espèces pour les nothotaxons : `Rosa × odorata` est maintenant analysé comme `Rosa odorata`, et non `Rosa ×`.
- Réconciliation des anciennes entrées Herbier utilisant `x` ou `×` afin d'éviter des doublons d'espèces.
