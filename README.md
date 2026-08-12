# Fleuretmoi

PWA personnelle et statique pour identifier des plantes avec Pl@ntNet et construire un Herbier local.

- GitHub Pages peut héberger le HTML/CSS/JS sans backend.
- La clé API Pl@ntNet est saisie dans l’application et stockée uniquement dans `localStorage` sur l’appareil.
- Les observations, espèces, photos et la file hors connexion sont stockées dans IndexedDB.
- Une espèce peut regrouper plusieurs observations ; `observation.speciesId` est la relation de référence.
- Une identification peut être corrigée, réassignée à une autre proposition Pl@ntNet ou saisie manuellement.
- Une sauvegarde JSON complète (photos incluses, clé API exclue) peut être exportée puis réimportée.

## Hors connexion

Le shell de l’application et les données déjà enregistrées restent disponibles hors connexion. Les nouvelles observations prises hors connexion sont conservées dans IndexedDB. Leur identification Pl@ntNet est retentée lorsque l’application est ouverte et qu’une connexion revient. Les erreurs de la file d’attente restent visibles et peuvent être relancées manuellement.

La carte utilise les tuiles OpenStreetMap et l’identification Pl@ntNet nécessite une connexion réseau.


## Laboratoire illustrations Wikimedia

Une page expérimentale `illustration-test.html` permet de tester le futur classement des illustrations botaniques sans modifier l’Herbier. Elle interroge Wikimedia Commons en lecture seule, analyse localement des miniatures et affiche les scores A/C/D/E/F ainsi que le bonus portrait. Les catégories multi-espèces et le recadrage ne sont utilisés qu’en secours.
