# TMB Golgothes 2026 — Carnet mobile

Version enrichie pour GitHub Pages.

## Contenu

- `index.html` : page principale du carnet
- `style.css` : mise en forme mobile
- `data.js` : données des étapes, hébergements, budget et contenus Trek
- `script.js` : interactions, carte, profils, checklist, aperçu animé
- `service-worker.js` : cache local du site
- `manifest.webmanifest` : préparation affichage mobile
- `.nojekyll` : évite certains traitements GitHub Pages
- `assets/icon.svg` : icône du site

## Modification intégrée dans cette version

Le point J4 a été réorganisé avec le scénario validé :

- J4 : Col Chécrouit → Courmayeur → Refuge Bertone → balcon du Val Ferret → Refuge Bonatti → descente vers Bivio Rifugio Bonatti → bus retour Courmayeur.
- Nuit J4 : Courmayeur, à réserver.
- J5 : bus Courmayeur → Bivio Rifugio Bonatti → remontée au Refuge Bonatti → Arnuva → Refuge Elena → Grand Col Ferret → La Peule.

Le site affiche désormais cette stratégie dans l’accueil, l’onglet Préparation, l’onglet Trek, les fiches étapes, le budget et la checklist.

## Mise en ligne GitHub Pages

1. Décompresser le ZIP.
2. Envoyer tous les fichiers à la racine du dépôt GitHub.
3. Vérifier dans `Settings > Pages` : `Deploy from branch`, branche `main`, dossier `/root`.
4. Après validation, attendre quelques minutes puis ouvrir l’URL publique.

Si l’ancienne version reste affichée, tester l’URL avec :

```text
?v=courmayeur-bonatti
```

ou ouvrir en navigation privée.
